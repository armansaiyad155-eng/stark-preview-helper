# Stark Preview Helper

A small local Node process, controlled entirely by [Stark](https://usestark.com)'s
web app over a local WebSocket. Opens sites and loads generated Chrome
extensions for real, native preview.

This is a standalone copy of the helper used by Stark's Builder page — you
only need this repo, not the main Stark app, to run it.

## Getting started

```bash
git clone https://github.com/armansaiyad155-eng/stark-preview-helper.git
cd stark-preview-helper
npm install
npm run setup
```

`npm run setup` registers the `stark-preview://` URL protocol with your OS.
From then on, clicking **Preview** on Stark boots this helper automatically —
no terminal needed after this one-time step. This is the standard deep-link
mechanism desktop apps like Zoom and Discord use: a web page can't start a
local program directly (browsers forbid it), but the OS will launch a
registered protocol handler on the page's behalf.

The first time the site boots it, your browser asks once whether
`stark-preview` links may open the helper — allow it (and optionally tick
"always allow"). First boot also downloads Chrome for Testing (~150 MB,
one-time, cached under `~/.cache/puppeteer`), so the first Preview click can
take a minute before the window appears.

## How it runs extensions

This drives a real, self-provisioned **Chrome for Testing** browser
(Google's own official build for exactly this kind of automation — same
underlying engine as branded Chrome, downloaded on first run via
`@puppeteer/browsers` and cached under `~/.cache/puppeteer` afterward, so
it doesn't touch or require any browser already installed on the machine).
Extensions are loaded via the Chrome DevTools Protocol's `Extensions`
domain (`Extensions.loadUnpacked`, exposed through puppeteer-core's
`browser.installExtension()`), so every `chrome.*` API — `activeTab`,
`captureVisibleTab`, `userScripts`, all of it — works natively. There is
no reimplemented subset to hit gaps in.

Two earlier approaches were tried and rejected before this one:

- **Electron + `electron-chrome-extensions`** (GPL-3.0): only implemented
  a partial subset of the extension platform. `activeTab`'s "grant on
  click" behavior and `chrome.tabs.captureVisibleTab` were both
  confirmed-missing, each only discoverable by testing a real extension.
- **A second, independent instance of the user's own daily-driver
  browser**: some browsers (e.g. Arc) refuse to launch a second,
  independent instance at all — fatal for a tool that needs to run
  alongside the browser the user already has open.

## Why pipe transport, and what it means for Google sign-in

The `Extensions` CDP domain requires **pipe transport**
(`--remote-debugging-pipe`) rather than the usual `--remote-debugging-port`
— so this launches Chrome with no exposed local debug port at all, plus
`ignoreDefaultArgs: ['--enable-automation']` to avoid `navigator.webdriver`
and the "controlled by automated software" infobar. Empirically verified
(real extension icon/popup/content-script injection, and real Google
sign-in with no block) against a Chrome for Testing build before this was
built out.

A dedicated, persistent profile lives at
`~/.stark-preview-chrome-profile` — separate from any other browser
profile on the machine, but persistent across restarts, so logins
(Gmail, YouTube, etc.) survive between sessions.

## Running it by hand

```bash
npm start
```

Same as ever — useful for development. The control server starts before
the browser so the website can tell "helper is booting" apart from "helper
not installed", and launching a second copy (e.g. the site re-firing the
protocol while it's already running) exits quietly instead of opening a
second Chrome window.

When launched via the protocol there's no terminal attached, so output
goes to `~/.stark-preview-helper.log` (macOS) — check there first if
Preview says it can't connect.

## A note on where this currently works

Use it from Stark's Builder page at `http://localhost:8080` during local
development. On the real deployed (HTTPS) Stark site, this doesn't yet
work — the local connection this depends on is a plain, unencrypted
WebSocket, which browsers block from HTTPS pages as mixed content. This is
a known, tracked limitation, not a bug in this repo specifically.
