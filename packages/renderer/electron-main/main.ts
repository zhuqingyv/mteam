// Electron 主进程入口：启动 backend 子进程 + 创建 BrowserWindow +
// 读桌面壁纸文件（而非截屏）+ 推送 winRect 给 renderer 做折射。
// 开发模式：loadURL(VITE_DEV_URL)，配合 Vite HMR。
// 生产模式：loadFile(dist/index.html)。
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';
import {
  getWallpaperPath,
  getWinRect,
  loadWallpaperDataUrl,
  throttle,
} from './wallpaper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;

const PET_SIZE = { width: 500, height: 320 };

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const { width: screenW, height: screenH } =
    screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: Math.round(screenW - PET_SIZE.width - 40),
    y: Math.round(screenH - PET_SIZE.height - 80),
    title: 'mteam',
    transparent: true,
    frame: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: true,
    // vibrancy 关掉 — WebGL 自己渲染玻璃，系统毛玻璃会叠白色底
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(__dirname, 'preload.cjs'),
    },
  });

  if (IS_DEV) {
    void mainWindow.loadURL(VITE_DEV_URL!);
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(resolve(__dirname, '..', 'dist', 'index.html'));
  }

  // 拖动/缩放：只推 bounds。renderer 拿新 bounds 算 UV 偏移，折射跟着位置走。
  // 16ms ≈ 60fps 节流，非常便宜（只是几个 float）。
  const pushRect = () => {
    const rect = getWinRect(mainWindow);
    if (rect && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-rect', rect);
    }
  };
  const throttledRect = throttle(pushRect, 16);
  mainWindow.on('move', throttledRect);
  mainWindow.on('resize', throttledRect);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 当前壁纸路径 + 已推送的 dataURL。路径没变就不重复解码/推送。
let currentWallpaperPath: string | null = null;

function refreshWallpaper(force = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const path = getWallpaperPath();
  if (!path) return;
  if (!force && path === currentWallpaperPath) return;
  const frame = loadWallpaperDataUrl(path);
  if (!frame) return;
  currentWallpaperPath = path;
  mainWindow.webContents.send('wallpaper-update', frame);
}

// renderer 启动时主动拉一次：返回 {dataUrl, width, height} + 当前 rect
ipcMain.handle('get-initial-frame', () => {
  const path = getWallpaperPath();
  console.log('[wallpaper] path:', path);
  const frame = path ? loadWallpaperDataUrl(path) : null;
  console.log(
    '[wallpaper] size:',
    frame ? `${frame.width}x${frame.height}` : 'null',
  );
  if (frame) currentWallpaperPath = path;
  const rect = getWinRect(mainWindow);
  return { frame, rect };
});

// 30 秒查一次壁纸路径；变了就解码新图推给 renderer
let wallpaperTimer: NodeJS.Timeout | null = null;
function startWallpaperLoop(): void {
  if (wallpaperTimer) return;
  wallpaperTimer = setInterval(() => refreshWallpaper(), 30_000);
}
function stopWallpaperLoop(): void {
  if (wallpaperTimer) {
    clearInterval(wallpaperTimer);
    wallpaperTimer = null;
  }
}

ipcMain.on(
  'window:resize',
  (_e, payload: { width: number; height: number }) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    const { width: screenW, height: screenH } =
      screen.getPrimaryDisplay().workAreaSize;
    // 以右下角为锚点 resize，让 pet ↔ chat 切换不会跳到屏幕另一侧
    const anchorRight = x + w;
    const anchorBottom = y + h;
    let newX = anchorRight - payload.width;
    let newY = anchorBottom - payload.height;
    newX = Math.max(8, Math.min(newX, screenW - payload.width - 8));
    newY = Math.max(8, Math.min(newY, screenH - payload.height - 8));
    mainWindow.setBounds(
      { x: newX, y: newY, width: payload.width, height: payload.height },
      false,
    );
  },
);

app.whenReady().then(() => {
  startBackend();
  createWindow();
  startWallpaperLoop();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWallpaperLoop();
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopWallpaperLoop();
  stopBackend();
});
