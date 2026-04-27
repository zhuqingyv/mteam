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
  stopBackend: () => stopBackend,
  startBackend: () => startBackend
});
module.exports = __toCommonJS(exports_backend);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var import_node_url = require("node:url");
var __dirname2 = import_node_path.dirname(import_node_url.fileURLToPath("file:///Users/zhuqingyu/project/mcp-team-hub/packages/renderer/electron-main/backend.ts"));
var BACKEND_ENTRY = import_node_path.resolve(__dirname2, "..", "..", "backend", "src", "http", "server.ts");
var child = null;
function startBackend() {
  if (child && child.exitCode === null)
    return child;
  child = import_node_child_process.spawn("bun", ["run", BACKEND_ENTRY], {
    stdio: ["ignore", "inherit", "inherit"],
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
  if (!child)
    return;
  try {
    child.kill("SIGTERM");
  } catch {}
  child = null;
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
function openPanel(key) {
  const cfg = key === "team" ? { ref: teamPanelWindow, w: 1200, h: 800, title: "mteam — 团队面板", q: "?window=team" } : { ref: settingsWindow, w: 600, h: 500, title: "mteam — 设置", q: "?window=settings" };
  if (cfg.ref && !cfg.ref.isDestroyed()) {
    cfg.ref.focus();
    return;
  }
  const win = new import_electron.BrowserWindow({ ...baseGlassOptions, width: cfg.w, height: cfg.h, title: cfg.title });
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
  stopBackend();
  if (process.platform !== "darwin")
    import_electron.app.quit();
});
import_electron.app.on("before-quit", () => {
  stopBackend();
});
