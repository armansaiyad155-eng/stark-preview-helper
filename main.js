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
const yauzl = require("yauzl");
const fsSync = require("node:fs");
const { pipeline } = require("node:stream/promises");

const PORT = 17872;
const CHROME_CACHE_DIR = path.join(os.homedir(), ".cache", "puppeteer");
const PROFILE_DIR = path.join(os.homedir(), ".stark-preview-chrome-profile");

// Only ever bind the control server to loopback. Without an explicit host,
// ws/Node listen on :: (ALL interfaces) — which put this port, and every
// command below, in reach of anyone on the same LAN (shared office wifi, a
// cafe, a compromised router). The Origin header below is NOT a second line
// of defense against that: Origin is honest only when a real browser sets
// it, and any non-browser client can forge it freely. Loopback-only is what
// actually keeps remote machines out.
const HOST = "127.0.0.1";

// Note these are all https:// except localhost, and browsers block an
// https:// page from opening an insecure ws:// connection — so in practice
// only http://localhost can reach us today. They're kept for the day the
// transport moves to wss://, and deliberately exclude wildcard third-party
// hosting domains: `*.lovable.app` / `*.lovableproject.com` would have
// trusted EVERY project any stranger deploys on those platforms, not just
// Stark's own. Stark's Lovable address is a single known host.
const TRUSTED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/usestark\.com$/,
  /^https:\/\/[^/.]+\.usestark\.com$/,
  /^https:\/\/usestark\.lovable\.app$/,
];

function isTrustedOrigin(origin) {
  return !!origin && TRUSTED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

// Anything that isn't a normal web page. file:// would turn "open a URL"
// into "read any file on this machine and render it in a window an
// attacker-supplied extension can read"; chrome:// reaches browser
// internals. The helper only ever needs to open real sites.
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

function assertSafeUrl(raw) {
  if (typeof raw !== "string" || !raw) throw new Error("Missing url");
  if (raw === "about:blank") return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid url");
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Refusing to open ${parsed.protocol} url — only http/https are allowed.`);
  }
  return parsed.href;
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

/* ------------------------------ safe zip extraction ------------------------------ */

// Replaces extract-zip, which has an unfixed symlink path-traversal flaw
// (GHSA-jmr9-qjv8-65gv): a zip entry can be a symlink pointing anywhere on
// disk, and a later entry writing "through" it lands outside the extraction
// directory — i.e. arbitrary file write. extract-zip has no patched version,
// so the fix is to stop using it. This does the same job on the same engine
// (yauzl, which extract-zip itself wraps) with the two checks it's missing:
// every path must stay inside the target directory, and symlinks are never
// created at all. A Chrome extension is plain files — it has no legitimate
// need for either.

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function entryIsSymlink(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & S_IFMT) === S_IFLNK;
}

// Resolve an entry name under rootDir, refusing anything that escapes it —
// absolute paths ("/etc/x"), drive paths ("C:\x"), and ../ traversal.
function resolveInside(rootDir, entryName) {
  if (path.isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) {
    throw new Error(`Refusing zip entry with an absolute path: ${entryName}`);
  }
  const dest = path.resolve(rootDir, entryName);
  const rel = path.relative(rootDir, dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing zip entry that escapes the extraction directory: ${entryName}`);
  }
  return dest;
}

async function safeExtractZip(zipPath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) =>
      err ? reject(err) : resolve(zf),
    );
  });

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      try {
        zipfile.close();
      } catch {
        // already closing
      }
      reject(err);
    };

    zipfile.on("error", fail);
    zipfile.on("end", resolve);

    zipfile.on("entry", (entry) => {
      (async () => {
        // Never materialize a symlink — this is the actual traversal vector.
        if (entryIsSymlink(entry)) {
          throw new Error(`Refusing symlink in extension zip: ${entry.fileName}`);
        }

        const isDir = entry.fileName.endsWith("/");
        const dest = resolveInside(destDir, entry.fileName);

        if (isDir) {
          await fs.mkdir(dest, { recursive: true });
          return;
        }

        await fs.mkdir(path.dirname(dest), { recursive: true });
        const readStream = await new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, rs) => (err ? rej(err) : res(rs)));
        });
        // 'wx' — never follow or overwrite something already there, so a
        // duplicate entry can't be used to clobber an earlier one.
        await pipeline(readStream, fsSync.createWriteStream(dest, { flags: "wx" }));
      })().then(
        () => zipfile.readEntry(),
        (err) => fail(err),
      );
    });

    zipfile.readEntry();
  });
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
    // Puppeteer's own default (unset) is a *forced* 800x600 CDP viewport
    // override, applied on top of whatever size the actual OS window opens
    // at — the two are independent, so the page content renders confined
    // to a small 800x600 box in one corner of a normal-sized window,
    // leaving the rest visibly empty. null turns that override off
    // entirely, so the page just fills the real window like a normal
    // browser. --window-size sets that real window to something roomier
    // than Chrome's own small default for a brand-new profile.
    defaultViewport: null,
    args: ["--window-size=1360,860"],
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
  const safeUrl = assertSafeUrl(url);
  await browserReady;
  await page.goto(safeUrl, { waitUntil: "load" });
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
  await safeExtractZip(zipPath, extractDir);

  if (loadedExtension) {
    const stale = loadedExtension;
    try {
      await browser.uninstallExtension(stale.id);
    } catch (err) {
      console.error("[Stark Preview Helper] uninstallExtension failed:", err?.message || err);
    }
    // Only safe to delete once Chrome has let go of it — every previous
    // preview otherwise left a full unpacked copy in the temp dir forever.
    await fs.rm(stale.workDir, { recursive: true, force: true }).catch((err) => {
      console.error("[Stark Preview Helper] temp cleanup failed:", err?.message || err);
    });
    loadedExtension = null;
  }

  const id = await browser.installExtension(extractDir);
  const extensions = await browser.extensions();
  const info = extensions.get(id);

  const manifestRaw = await fs.readFile(path.join(extractDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
  const name = info?.name || manifest.name || "Extension";

  loadedExtension = { id, name, dir: extractDir, workDir };

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
      wss = new WebSocketServer({ port: PORT, host: HOST });
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
    console.log(`[Stark Preview Helper] control server listening on ws://${HOST}:${PORT} (loopback only)`);
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
