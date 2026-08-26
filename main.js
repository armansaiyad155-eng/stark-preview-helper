// Stark Preview Helper — a small local Node process controlled entirely by
// Stark's web app over a WebSocket. Opens sites and loads generated Chrome
// extensions for real, native preview.
//
// Runs a real, self-provisioned "Chrome for Testing" build (Google's
// official automation-oriented Chrome build — same engine as branded
// Chrome, downloaded on first run via @puppeteer/browsers, cached
// permanently after that) rather than reimplementing any part of the
// extension platform. Every chrome.* API — activeTab, captureVisibleTab,
// userScripts, all of it — works because this genuinely is Chrome, not a
// partial reimplementation of it.
//
// Two prior approaches were tried and rejected before this one:
//   - Electron + electron-chrome-extensions (GPL-3.0): only implements a
//     partial subset of the extension platform. activeTab's "grant on
//     click" behavior and chrome.tabs.captureVisibleTab were both
//     confirmed-missing, each discovered only by testing a real extension.
//   - The user's own Arc browser: refuses to launch a second, independent
//     instance at all ("Arc is already open. Only one instance of Arc can
//     be opened at a time.") — fatal for a tool that must run alongside
//     the user's regular daily-driver browser.
//
// The extension loader uses CDP's `Extensions` domain (Extensions.loadUnpacked
// / uninstall), exposed via puppeteer-core's browser.installExtension() /
// uninstallExtension(). That domain requires **pipe transport**
// (`--remote-debugging-pipe`, no `--remote-debugging-port` at all) — which
// turned out to be a genuine advantage for the Google-login concern this
// whole rewrite was gated on: no open local debug port to fingerprint.
// Empirically verified working (real extension icon/popup/content-script,
// AND real Google sign-in with no block) against a Chrome-for-Testing
// build before this was written.

const puppeteer = require("puppeteer-core");
const {
  Browser: PuppeteerBrowser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} = require("@puppeteer/browsers");
const { WebSocketServer } = require("ws");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const extractZip = require("extract-zip");

const PORT = 17872;
const CHROME_CACHE_DIR = path.join(os.homedir(), ".cache", "puppeteer");
const PROFILE_DIR = path.join(os.homedir(), ".stark-preview-chrome-profile");

const TRUSTED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^https:\/\/usestark\.com$/,
  /^https:\/\/[^/]+\.usestark\.com$/,
  /^https:\/\/[^/]+\.lovable\.app$/,
  /^https:\/\/[^/]+\.lovableproject\.com$/,
];

function isTrustedOrigin(origin) {
  return !!origin && TRUSTED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

let browser = null;
let page = null;
let loadedExtension = null; // { id, name, dir }

// Resolves once Chrome is actually up. The control server starts accepting
// connections BEFORE the browser finishes launching (on the very first run
// that includes a ~150 MB Chrome for Testing download), so the website can
// tell "helper booting" apart from "helper not installed" while commands
// simply wait here.
let resolveBrowserReady;
const browserReady = new Promise((resolve) => {
  resolveBrowserReady = resolve;
});

/* --------------------------- Chrome provisioning --------------------------- */

async function ensureChromeInstalled() {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("Could not detect this machine's platform for Chrome for Testing.");

  const buildId = await resolveBuildId(PuppeteerBrowser.CHROME, platform, "stable");
  const executablePath = computeExecutablePath({
    cacheDir: CHROME_CACHE_DIR,
    platform,
    browser: PuppeteerBrowser.CHROME,
    buildId,
  });

  try {
    await fs.access(executablePath);
    return executablePath;
  } catch {
    // Not cached yet — one-time download, same convention as `puppeteer`'s
    // own postinstall step. Subsequent runs skip this entirely.
    console.log(`[Stark Preview Helper] Downloading Chrome for Testing (${buildId}), one-time setup...`);
    await install({
      cacheDir: CHROME_CACHE_DIR,
      platform,
      browser: PuppeteerBrowser.CHROME,
      buildId,
      downloadProgressCallback: "default",
    });
    console.log("[Stark Preview Helper] Chrome for Testing installed.");
    return executablePath;
  }
}

/* ------------------------------ browser lifecycle ------------------------------ */

async function launchBrowser() {
  const executablePath = await ensureChromeInstalled();

  browser = await puppeteer.launch({
    executablePath,
    userDataDir: PROFILE_DIR,
    headless: false,
    pipe: true, // required for the Extensions CDP domain; also means no
    // exposed local debug port to fingerprint.
    enableExtensions: true, // adds --enable-unsafe-extension-debugging,
    // drops puppeteer's default --disable-extensions.
    ignoreDefaultArgs: ["--enable-automation"], // avoids navigator.webdriver
    // = true and the "controlled by automated software" infobar.
  });

  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  resolveBrowserReady();

  // Pipe transport ties Chrome's lifetime to this process, but also cover
  // the case where the user closes the window directly — same behavior as
  // the old app's window-all-closed -> quit.
  browser.on("disconnected", () => {
    console.error("[Stark Preview Helper] Browser closed — exiting.");
    process.exit(0);
  });
}

/* ------------------------------- commands ------------------------------- */

async function openUrl(url) {
  await browserReady;
  await page.goto(url, { waitUntil: "load" });
  return { ok: true };
}

async function loadExtension(zipBase64) {
  await browserReady;
  // The browser sends the zip's bytes directly (it already has the
  // authenticated file data in memory to build it) rather than fetching a
  // URL — that would otherwise need a new, unauthenticated download
  // endpoint on Stark's server just for this.
  if (!zipBase64) throw new Error("Missing zip data");
  const buf = Buffer.from(zipBase64, "base64");

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "stark-ext-"));
  const zipPath = path.join(workDir, "ext.zip");
  await fs.writeFile(zipPath, buf);
  const extractDir = path.join(workDir, "unpacked");
  await extractZip(zipPath, { dir: extractDir });

  if (loadedExtension) {
    try {
      await browser.uninstallExtension(loadedExtension.id);
    } catch (err) {
      console.error("[Stark Preview Helper] uninstallExtension failed:", err?.message || err);
    }
    loadedExtension = null;
  }

  const id = await browser.installExtension(extractDir);
  const extensions = await browser.extensions();
  const info = extensions.get(id);

  const manifestRaw = await fs.readFile(path.join(extractDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
  const name = info?.name || manifest.name || "Extension";

  loadedExtension = { id, name, dir: extractDir };

  // Content scripts only inject on load, so reload whatever's open to give
  // them a chance to run — same as reloading a tab after installing in
  // Chrome.
  const currentUrl = page.url();
  if (currentUrl && currentUrl !== "about:blank") {
    await page.reload({ waitUntil: "load", timeout: 8000 }).catch((err) => {
      console.error("[Stark Preview Helper] reload after loadExtension failed:", err?.message || err);
    });
  }

  return { ok: true, extensionId: id, name, hasPopup: !!popupPath };
}

async function status() {
  return {
    ok: true,
    // The website polls this after protocol-booting us: connected-but-not-
    // -ready means "still starting up" (possibly the first-run Chrome
    // download), so it should keep waiting instead of erroring out.
    ready: !!page,
    currentUrl: page ? page.url() : null,
    currentTitle: page ? await page.title().catch(() => null) : null,
    loadedExtensionId: loadedExtension?.id ?? null,
  };
}

/* --------------------------- Stark control server --------------------------- */

// Without the control server this browser can't be driven by Stark at all,
// so say why in plain terms rather than leaving a silently inert window.
function reportControlServerError(err) {
  const inUse = err?.code === "EADDRINUSE";
  const message = inUse
    ? `Another copy of Stark Preview Helper is already running (port ${PORT} is taken).\n\nClose the other one and start this again.`
    : `Stark Preview Helper couldn't start its control server:\n\n${err?.message || err}`;
  console.error("[Stark Preview Helper]", message);
}

// Resolves once the server is listening; rejects on startup errors such as
// EADDRINUSE, so main() can tell "another copy is already running" apart
// from real failures.
function startControlServer() {
  return new Promise((resolve, reject) => {
    let wss;
    try {
      wss = new WebSocketServer({ port: PORT });
    } catch (err) {
      reject(err);
      return;
    }

    wss.once("error", (err) => reject(err));
    wss.on("listening", () => {
      wss.removeAllListeners("error");
      wss.on("error", reportControlServerError);
      resolve();
    });

    wss.on("connection", (ws, req) => {
    if (!isTrustedOrigin(req.headers.origin)) {
      ws.close(4001, "Untrusted origin");
      return;
    }
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      try {
        let result;
        switch (msg.type) {
          case "open":
            result = await openUrl(msg.url);
            break;
          case "loadExtension":
            result = await loadExtension(msg.zipBase64);
            break;
          case "status":
            result = await status();
            break;
          default:
            result = { ok: false, error: `Unknown command: ${msg.type}` };
        }
        ws.send(JSON.stringify({ id: msg.id, ...result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: err?.message || String(err) }));
      }
    });
    });
    console.log(`[Stark Preview Helper] control server listening on ws://localhost:${PORT}`);
  });
}

process.on("uncaughtException", (err) => {
  console.error("[Stark Preview Helper] uncaught exception:", err?.stack || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[Stark Preview Helper] unhandled rejection:", err?.stack || err);
});
process.on("SIGINT", async () => {
  await browser?.close().catch(() => {});
  process.exit(0);
});

// Control server FIRST, browser second: the website boots us via the
// stark-preview:// protocol and polls `status` until ready — if the
// first-run Chrome download blocked the control server, a slow connection
// would look exactly like "helper not installed". This way we can answer
// "starting up" right away.
async function main() {
  await startControlServer();
  await launchBrowser();
  console.log("[Stark Preview Helper] browser ready.");
}

main().catch((err) => {
  // Launched while another copy already holds the port — the normal case
  // when the site re-fires stark-preview:// with the helper already up.
  // Quietly bow out; the running copy handles everything.
  if (err?.code === "EADDRINUSE") process.exit(0);
  console.error("[Stark Preview Helper] failed to start:", err?.stack || err);
  process.exit(1);
});
