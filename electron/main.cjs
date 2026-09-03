/**
 * Spinal Board — Electron main process (Windows desktop shell).
 *
 * V1 architecture (locked): bundle the existing zero-dependency Node dev
 * server inside Electron and drive the editor from a BrowserWindow.
 *
 *   - The server (scripts/serve.mjs) runs as a child process launched with
 *     ELECTRON_RUN_AS_NODE=1 + process.execPath — i.e. Electron's OWN Node,
 *     so its fs reads transparently from app.asar (dist/, vendor/spine-*,
 *     index.html, …). No separate Node install is needed.
 *   - content/ + exports/ never live inside the install dir: the packaged app
 *     defaults them to Documents\SpinalBoard\{content,exports} (created on
 *     first run). An existing library can be repointed via the LWPG_CONTENT /
 *     LWPG_EXPORTS env vars (also honoured in dev).
 *   - Port: 8080 by default, next free port if busy.
 *   - Single instance; window closes the app, which stops the server child.
 *
 * No preload/IPC is needed for V1: audio upload, scene save and export all go
 * through the existing HTTP endpoints, and "Open folder" is served the same
 * way (cmd /c start on Windows).
 */
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const APP_NAME = "Spinal Board";
const PREFERRED_PORT = Number(process.env.LWPG_PORT || 8080);
const MAX_PORT_TRIES = 50; // scan 8080..8129 before giving up
const ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "scripts", "serve.mjs");

// Keep the dev shell (`electron .`, unpackaged) away from the installed app:
// both otherwise resolve the same userData dir (%APPDATA%\spinal-board) from
// the package.json `name`, which would make them fight over the single-
// instance lock and share localStorage/IndexedDB. Dev gets its own folder.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "spinal-board-dev"));
}

let mainWindow = null;
let serverChild = null;
let serverPort = null;
let quitting = false;

/* ------------------------------------------------------------------ *
 * Content / export directories
 * ------------------------------------------------------------------ */

/**
 * Resolve where content/exports point. Packaged: Documents\SpinalBoard\…
 * (created on first run, seeded with a README). Dev: LWPG_* env when set,
 * otherwise leave unset so serve.mjs keeps its repo defaults.
 */
function resolveUserDirs() {
  const dirs = {};
  if (!app.isPackaged) {
    if (process.env.LWPG_CONTENT) dirs.content = path.resolve(process.env.LWPG_CONTENT);
    if (process.env.LWPG_EXPORTS) dirs.exports = path.resolve(process.env.LWPG_EXPORTS);
    return dirs; // dev: repo content/ + exports/ stay the defaults
  }

  const base = path.join(app.getPath("documents"), "SpinalBoard");
  dirs.content = process.env.LWPG_CONTENT
    ? path.resolve(process.env.LWPG_CONTENT)
    : path.join(base, "content");
  dirs.exports = process.env.LWPG_EXPORTS
    ? path.resolve(process.env.LWPG_EXPORTS)
    : path.join(base, "exports");

  for (const d of [dirs.content, dirs.exports]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const readme = path.join(dirs.content, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        "# Spinal Board — content library",
        "",
        "Drop your own assets here — Spine skeletons, Live2D models, images,",
        "GIFs, videos and audio. Every DIRECT folder under this one becomes a",
        "picker tab in the editor (e.g. put a folder named `characters` here).",
        "",
        "Nothing is ever distributed: exports copy only the files a scene",
        "references. See the app's documentation for the full folder rules.",
        "",
      ].join("\n")
    );
  }
  return dirs;
}

/* ------------------------------------------------------------------ *
 * Port + server child
 * ------------------------------------------------------------------ */

/** Find the first free port at or above `preferred` (binds 127.0.0.1). */
function probePort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      if (port > preferred + MAX_PORT_TRIES) return resolve(null);
      const srv = net.createServer();
      srv.once("error", () => {
        srv.close(() => tryPort(port + 1));
      });
      srv.listen(port, "127.0.0.1", () => {
        const chosen = srv.address().port;
        srv.close(() => resolve(chosen));
      });
    };
    tryPort(preferred);
  });
}

/** Poll GET / until the local server answers (or the timeout elapses). */
function waitForServer(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function startServer(port, dirs) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
  };
  if (dirs.content) env.LWPG_CONTENT = dirs.content;
  if (dirs.exports) env.LWPG_EXPORTS = dirs.exports;

  const child = spawn(process.execPath, [SERVER_ENTRY, String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  child.on("exit", (code) => {
    if (quitting) return;
    console.error(`[spinal-board] server process exited unexpectedly (code ${code})`);
    dialog.showErrorBox(APP_NAME, "The internal server stopped unexpectedly. The app will close.");
    app.quit();
  });
  return child;
}

/* ------------------------------------------------------------------ *
 * Window + lifecycle
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: "#141414",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

function shutdown() {
  quitting = true;
  if (serverChild) {
    try {
      serverChild.kill();
    } catch {
      /* ignore */
    }
    serverChild = null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const dirs = resolveUserDirs();

    serverPort = await probePort(PREFERRED_PORT);
    if (!serverPort) {
      dialog.showErrorBox(
        APP_NAME,
        `No free port found in range ${PREFERRED_PORT}–${PREFERRED_PORT + MAX_PORT_TRIES - 1}.`
      );
      app.quit();
      return;
    }

    serverChild = startServer(serverPort, dirs);
    const ready = await waitForServer(serverPort, 15000);
    if (!ready) {
      dialog.showErrorBox(
        APP_NAME,
        "The internal server did not start in time. The app will close."
      );
      app.quit();
      return;
    }

    createWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => shutdown());
  app.on("will-quit", () => shutdown());
  app.on("activate", () => {
    // macOS convention (not a V1 target, but harmless): re-create the window.
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
  });
}
