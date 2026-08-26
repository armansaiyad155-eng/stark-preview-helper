// One-time setup for Stark Preview Helper: registers the `stark-preview://`
// URL protocol with the OS so Stark's website can boot this helper with one
// click — no terminal needed after this. This is the same deep-link
// mechanism desktop apps like Zoom, Discord, and Spotify use for
// "open in app" links: a web page can't start a local program directly
// (browsers forbid it), but the OS will launch a registered protocol
// handler on the page's behalf.
//
// Run once:  npm run setup

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const PROTOCOL = "stark-preview";
const HELPER_MAIN = path.join(__dirname, "main.js");
const NODE = process.execPath; // absolute path to the node running this script

/* --------------------------------- macOS --------------------------------- */
// macOS registers URL schemes from an .app bundle's Info.plist, so we build
// a minimal launcher app in ~/Applications and nudge LaunchServices.

function installMac() {
  const appDir = path.join(os.homedir(), "Applications", "Stark Preview Helper.app");
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  fs.mkdirSync(macosDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Stark Preview Helper</string>
  <key>CFBundleIdentifier</key>
  <string>com.stark.preview-helper</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Stark Preview Helper</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${PROTOCOL}</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), plist);

  // No terminal is attached when the OS launches us, so log to a file —
  // that log is the first place to look if Preview ever says it can't connect.
  const launcher = `#!/bin/bash
exec "${NODE}" "${HELPER_MAIN}" >> "$HOME/.stark-preview-helper.log" 2>&1
`;
  const launcherPath = path.join(macosDir, "launcher");
  fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });

  try {
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appDir],
      { stdio: "ignore" },
    );
  } catch {
    // Best-effort: LaunchServices also picks up new apps in ~/Applications on its own.
  }
  console.log(`Registered ${PROTOCOL}:// -> ${appDir}`);
}

/* --------------------------------- Windows -------------------------------- */
// Windows registers protocols in HKCU — no admin rights needed.

function installWindows() {
  const reg = (args) => execFileSync("reg", args, { stdio: "ignore" });
  const base = `HKCU\\Software\\Classes\\${PROTOCOL}`;
  reg(["add", base, "/ve", "/d", "URL:Stark Preview Helper Protocol", "/f"]);
  reg(["add", base, "/v", "URL Protocol", "/d", "", "/f"]);
  reg([
    "add",
    `${base}\\shell\\open\\command`,
    "/ve",
    "/d",
    `"${NODE}" "${HELPER_MAIN}"`,
    "/f",
  ]);
  console.log(`Registered ${PROTOCOL}:// in HKCU\\Software\\Classes\\${PROTOCOL}`);
}

/* ---------------------------------- Linux --------------------------------- */
// Freedesktop: a .desktop file declaring the scheme handler + xdg-mime default.

function installLinux() {
  const appsDir = path.join(os.homedir(), ".local", "share", "applications");
  fs.mkdirSync(appsDir, { recursive: true });
  const desktop = `[Desktop Entry]
Type=Application
Name=Stark Preview Helper
Exec="${NODE}" "${HELPER_MAIN}"
NoDisplay=true
MimeType=x-scheme-handler/${PROTOCOL};
`;
  const file = path.join(appsDir, "stark-preview-helper.desktop");
  fs.writeFileSync(file, desktop);
  for (const cmd of [
    ["xdg-mime", ["default", "stark-preview-helper.desktop", `x-scheme-handler/${PROTOCOL}`]],
    ["update-desktop-database", [appsDir]],
  ]) {
    try {
      execFileSync(cmd[0], cmd[1], { stdio: "ignore" });
    } catch {
      // Not every distro has both; the .desktop file alone is often enough.
    }
  }
  console.log(`Registered ${PROTOCOL}:// via ${file}`);
}

/* ---------------------------------- main ---------------------------------- */

console.log("Stark Preview Helper — one-time setup");
console.log(`Helper: ${HELPER_MAIN}`);
console.log(`Node:   ${NODE}`);

switch (process.platform) {
  case "darwin":
    installMac();
    break;
  case "win32":
    installWindows();
    break;
  case "linux":
    installLinux();
    break;
  default:
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
}

console.log(
  `\nDone. From now on, clicking Preview on Stark boots this helper automatically.` +
    `\nThe first time, your browser will ask permission to open "${PROTOCOL}" links — allow it.` +
    `\nYou can still run it by hand anytime with: npm start`,
);
