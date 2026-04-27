var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// electron-main/backend.ts
var exports_backend = {};
__export(exports_backend, {
  stopBackendAndWait: () => stopBackendAndWait,
  stopBackend: () => stopBackend,
  startBackend: () => startBackend
});
module.exports = __toCommonJS(exports_backend);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var import_node_url = require("node:url");
var __dirname2 = import_node_path.dirname(import_node_url.fileURLToPath("file:///Users/zhuqingyu/project/mcp-team-hub/packages/renderer/electron-main/backend.ts"));
var BACKEND_ENTRY = import_node_path.resolve(__dirname2, "..", "..", "backend", "src", "http", "server.ts");
var KILL_GRACE_MS = 2000;
var STOP_WAIT_MS = 4000;
var child = null;
function startBackend() {
  if (child && child.exitCode === null)
    return child;
  child = import_node_child_process.spawn("bun", ["run", BACKEND_ENTRY], {
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env }
  });
  child.on("exit", (code, signal) => {
    process.stderr.write(`[electron] backend exited code=${code} signal=${signal}
`);
    child = null;
  });
  return child;
}
function stopBackend() {
  if (!child || typeof child.pid !== "number")
    return;
  const pid = child.pid;
  child = null;
  const kill = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref?.();
}
async function stopBackendAndWait() {
  if (!child || typeof child.pid !== "number")
    return;
  const c = child;
  const pid = c.pid;
  child = null;
  const kill = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  const exited = new Promise((resolve2) => {
    if (c.exitCode !== null || c.signalCode) {
      resolve2();
      return;
    }
    c.once("exit", () => resolve2());
  });
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
  await Promise.race([
    exited,
    new Promise((r) => setTimeout(r, STOP_WAIT_MS))
  ]);
  clearTimeout(timer);
}

// electron-main/main.ts
var import_electron = require("electron");
var import_node_path2 = require("node:path");
var import_node_url2 = require("node:url");
var __dirname3 = import_node_path2.dirname(import_node_url2.fileURLToPath("file:///Users/zhuqingyu/project/mcp-team-hub/packages/renderer/electron-main/main.ts"));
var ICON_PATH = import_node_path2.resolve(__dirname3, "..", "build", "icon.png");
var VITE_DEV_URL = process.env.VITE_DEV_URL;
var IS_DEV = !!VITE_DEV_URL;
var PET_SIZE = { width: 380, height: 120 };
if (IS_DEV) {
  const CDP_PORT = process.env.MTEAM_CDP_PORT || "9222";
  import_electron.app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
  import_electron.app.commandLine.appendSwitch("remote-allow-origins", "*");
}
var mainWindow = null;
var teamPanelWindow = null;
var settingsWindow = null;
var baseGlassOptions = {
  transparent: true,
  frame: false,
  hasShadow: false,
  backgroundColor: "#00000000",
  resizable: true,
  icon: import_electron.nativeImage.createFromPath(ICON_PATH),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: import_node_path2.resolve(__dirname3, "preload.cjs")
  }
};
function loadRenderer(win, query = "") {
  if (IS_DEV) {
    win.loadURL(VITE_DEV_URL + query);
  } else {
    win.loadFile(import_node_path2.resolve(__dirname3, "..", "dist", "index.html"), {
      search: query.replace(/^\?/, "")
    });
  }
}
function createWindow() {
  const { width: screenW, height: screenH } = import_electron.screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new import_electron.BrowserWindow({
    ...baseGlassOptions,
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: Math.round(screenW - PET_SIZE.width - 40),
    y: Math.round(screenH - PET_SIZE.height - 80),
    title: "mteam",
    alwaysOnTop: true
  });
  loadRenderer(mainWindow);
  let moveIdleTimer = null;
  mainWindow.on("move", () => {
    if (!mainWindow)
      return;
    mainWindow.webContents.send("window:drag-start");
    if (moveIdleTimer)
      clearTimeout(moveIdleTimer);
    moveIdleTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("window:drag-end");
      }
    }, 120);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
var lastTeamOpenAt = 0;
var TEAM_OPEN_DEBOUNCE_MS = 500;
function openPanel(key) {
  const cfg = key === "team" ? { ref: teamPanelWindow, w: 1200, h: 800, minW: 800, minH: 600, title: "mteam — 团队面板", q: "?window=team" } : { ref: settingsWindow, w: 600, h: 500, minW: 400, minH: 300, title: "mteam — 设置", q: "?window=settings" };
  if (cfg.ref && cfg.ref.isDestroyed()) {
    if (key === "team")
      teamPanelWindow = null;
    else
      settingsWindow = null;
    cfg.ref = null;
  }
  if (cfg.ref && !cfg.ref.isDestroyed()) {
    if (key === "team") {
      const now = Date.now();
      if (now - lastTeamOpenAt < TEAM_OPEN_DEBOUNCE_MS)
        return;
      lastTeamOpenAt = now;
      cfg.ref.focus();
    } else {
      cfg.ref.close();
    }
    return;
  }
  if (key === "team")
    lastTeamOpenAt = Date.now();
  const win = new import_electron.BrowserWindow({
    ...baseGlassOptions,
    width: cfg.w,
    height: cfg.h,
    minWidth: cfg.minW,
    minHeight: cfg.minH,
    title: cfg.title
  });
  if (key === "team")
    teamPanelWindow = win;
  else
    settingsWindow = win;
  loadRenderer(win, cfg.q);
  win.on("closed", () => {
    if (key === "team")
      teamPanelWindow = null;
    else
      settingsWindow = null;
  });
}
import_electron.ipcMain.on("window:open-team-panel", () => openPanel("team"));
import_electron.ipcMain.on("window:open-settings", () => openPanel("settings"));
var RESIZE_DIR_MAP = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  tl: "top-left",
  tr: "top-right",
  bl: "bottom-left",
  br: "bottom-right"
};
import_electron.ipcMain.on("window:start-resize", (_e, direction) => {
  if (!mainWindow)
    return;
  mainWindow.webContents.send("resize-started");
  const mapped = RESIZE_DIR_MAP[direction];
  if (mapped)
    mainWindow.startResizing?.(mapped);
});
import_electron.ipcMain.on("window:resize", (_e, payload) => {
  if (!mainWindow)
    return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  let newX = x;
  let newY = y;
  if (payload.anchor === "bottom-right") {
    newX = x + w - payload.width;
    newY = y + h - payload.height;
  }
  const wa = import_electron.screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  newX = Math.max(wa.x + 8, Math.min(newX, wa.x + wa.width - payload.width - 8));
  newY = Math.max(wa.y + 8, Math.min(newY, wa.y + wa.height - payload.height - 8));
  mainWindow.setBounds({ x: newX, y: newY, width: payload.width, height: payload.height }, payload.animate ?? false);
});
import_electron.app.whenReady().then(() => {
  if (process.platform === "darwin" && import_electron.app.dock) {
    import_electron.app.dock.setIcon(import_electron.nativeImage.createFromPath(ICON_PATH));
  }
  startBackend();
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
});
import_electron.app.on("window-all-closed", () => {
  import_electron.app.quit();
});
var quitting = false;
import_electron.app.on("before-quit", (event) => {
  if (quitting)
    return;
  quitting = true;
  event.preventDefault();
  stopBackendAndWait().finally(() => import_electron.app.exit(0));
});
import_electron.app.on("quit", () => process.exit(0));
