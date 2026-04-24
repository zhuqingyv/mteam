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
var import_electron2 = require("electron");
var import_node_path3 = require("node:path");
var import_node_url2 = require("node:url");

// electron-main/wallpaper.ts
var import_electron = require("electron");
var import_node_child_process2 = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var SYSTEM_DEFAULT = "/System/Library/CoreServices/DefaultDesktop.heic";
function getWallpaperPath() {
  if (process.platform !== "darwin")
    return null;
  try {
    const out = import_node_child_process2.execFileSync("osascript", [
      "-e",
      'tell application "System Events" to tell every desktop to get picture'
    ], { encoding: "utf8", timeout: 3000 }).trim();
    const first = out.split(",")[0]?.trim();
    if (first && import_node_fs.existsSync(first))
      return first;
  } catch {}
  if (import_node_fs.existsSync(SYSTEM_DEFAULT))
    return SYSTEM_DEFAULT;
  return null;
}
function tempPng() {
  try {
    return import_node_path2.join(import_electron.app.getPath("temp"), "mteam-wallpaper.png");
  } catch {
    return "/tmp/mteam-wallpaper.png";
  }
}
function loadWallpaperDataUrl(path) {
  try {
    const out = tempPng().replace(/\.png$/, ".jpg");
    import_node_child_process2.execFileSync("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "60",
      path,
      "--out",
      out
    ], { timeout: 1e4 });
    const img = import_electron.nativeImage.createFromPath(out);
    if (img.isEmpty())
      return null;
    const s = img.getSize();
    return { dataUrl: img.toDataURL(), width: s.width, height: s.height };
  } catch {
    return null;
  }
}
function getDisplayForWindow(win) {
  return import_electron.screen.getDisplayMatching(win.getBounds());
}
function getWinRect(win) {
  if (!win || win.isDestroyed())
    return null;
  const b = win.getBounds();
  const d = getDisplayForWindow(win);
  const physW = d.size.width * d.scaleFactor;
  const physH = d.size.height * d.scaleFactor;
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    display: {
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height
    },
    displayAspect: physW / physH
  };
}
function throttle(fn, waitMs) {
  let last = 0;
  let trailing = null;
  return (...args) => {
    const now = Date.now();
    const remaining = waitMs - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!trailing) {
      trailing = setTimeout(() => {
        last = Date.now();
        trailing = null;
        fn(...args);
      }, remaining);
    }
  };
}

// electron-main/main.ts
var __dirname3 = import_node_path3.dirname(import_node_url2.fileURLToPath("file:///Users/zhuqingyu/project/mcp-team-hub/packages/renderer/electron-main/main.ts"));
var VITE_DEV_URL = process.env.VITE_DEV_URL;
var IS_DEV = !!VITE_DEV_URL;
var PET_SIZE = { width: 500, height: 320 };
var mainWindow = null;
function createWindow() {
  const { width: screenW, height: screenH } = import_electron2.screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new import_electron2.BrowserWindow({
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: import_node_path3.resolve(__dirname3, "preload.cjs")
    }
  });
  if (IS_DEV) {
    mainWindow.loadURL(VITE_DEV_URL);
  } else {
    mainWindow.loadFile(import_node_path3.resolve(__dirname3, "..", "dist", "index.html"));
  }
  const pushRect = () => {
    const rect = getWinRect(mainWindow);
    if (rect && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-rect", rect);
    }
  };
  const throttledRect = throttle(pushRect, 16);
  mainWindow.on("move", throttledRect);
  mainWindow.on("resize", throttledRect);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
var currentWallpaperPath = null;
function refreshWallpaper(force = false) {
  if (!mainWindow || mainWindow.isDestroyed())
    return;
  const path = getWallpaperPath();
  if (!path)
    return;
  if (!force && path === currentWallpaperPath)
    return;
  const frame = loadWallpaperDataUrl(path);
  if (!frame)
    return;
  currentWallpaperPath = path;
  mainWindow.webContents.send("wallpaper-update", frame);
}
import_electron2.ipcMain.handle("get-initial-frame", () => {
  const path = getWallpaperPath();
  console.log("[wallpaper] path:", path);
  const frame = path ? loadWallpaperDataUrl(path) : null;
  console.log("[wallpaper] size:", frame ? `${frame.width}x${frame.height}` : "null");
  if (frame)
    currentWallpaperPath = path;
  const rect = getWinRect(mainWindow);
  return { frame, rect };
});
var wallpaperTimer = null;
function startWallpaperLoop() {
  if (wallpaperTimer)
    return;
  wallpaperTimer = setInterval(() => refreshWallpaper(), 30000);
}
function stopWallpaperLoop() {
  if (wallpaperTimer) {
    clearInterval(wallpaperTimer);
    wallpaperTimer = null;
  }
}
import_electron2.ipcMain.on("window:resize", (_e, payload) => {
  if (!mainWindow)
    return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  const { width: screenW, height: screenH } = import_electron2.screen.getPrimaryDisplay().workAreaSize;
  const anchorRight = x + w;
  const anchorBottom = y + h;
  let newX = anchorRight - payload.width;
  let newY = anchorBottom - payload.height;
  newX = Math.max(8, Math.min(newX, screenW - payload.width - 8));
  newY = Math.max(8, Math.min(newY, screenH - payload.height - 8));
  mainWindow.setBounds({ x: newX, y: newY, width: payload.width, height: payload.height }, false);
});
import_electron2.app.whenReady().then(() => {
  startBackend();
  createWindow();
  startWallpaperLoop();
  import_electron2.app.on("activate", () => {
    if (import_electron2.BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
});
import_electron2.app.on("window-all-closed", () => {
  stopWallpaperLoop();
  stopBackend();
  if (process.platform !== "darwin")
    import_electron2.app.quit();
});
import_electron2.app.on("before-quit", () => {
  stopWallpaperLoop();
  stopBackend();
});
