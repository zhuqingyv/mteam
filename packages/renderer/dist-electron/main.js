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
var BACKEND_ENTRY = import_node_path.resolve(__dirname2, "..", "..", "backend", "src", "server.ts");
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
var VITE_DEV_URL = process.env.VITE_DEV_URL;
var IS_DEV = !!VITE_DEV_URL;
var PET_SIZE = { width: 220, height: 96 };
var mainWindow = null;
function createWindow() {
  const isMac = process.platform === "darwin";
  const { width: screenW, height: screenH } = import_electron.screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new import_electron.BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: Math.round(screenW - PET_SIZE.width - 40),
    y: Math.round(screenH - PET_SIZE.height - 80),
    title: "mteam",
    transparent: true,
    frame: false,
    hasShadow: true,
    backgroundColor: "#00000000",
    resizable: true,
    alwaysOnTop: true,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: import_node_path2.resolve(__dirname3, "preload.cjs")
    }
  });
  if (IS_DEV) {
    mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(import_node_path2.resolve(__dirname3, "..", "dist", "index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
import_electron.ipcMain.on("window:resize", (_e, payload) => {
  if (!mainWindow)
    return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  const { width: screenW, height: screenH } = import_electron.screen.getPrimaryDisplay().workAreaSize;
  const anchorRight = x + w;
  const anchorBottom = y + h;
  let newX = anchorRight - payload.width;
  let newY = anchorBottom - payload.height;
  newX = Math.max(8, Math.min(newX, screenW - payload.width - 8));
  newY = Math.max(8, Math.min(newY, screenH - payload.height - 8));
  mainWindow.setBounds({ x: newX, y: newY, width: payload.width, height: payload.height }, true);
});
import_electron.app.whenReady().then(() => {
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
