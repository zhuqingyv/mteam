// Electron 主进程入口：启动 backend 子进程 + 创建 BrowserWindow。
// 开发模式：loadURL(VITE_DEV_URL)，配合 Vite HMR。
// 生产模式：loadFile(dist/index.html)。
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;

const PET_SIZE = { width: 500, height: 320 };
const CHAT_SIZE = { width: 900, height: 680 };

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const isMac = process.platform === 'darwin';
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
    // vibrancy 关掉 — WebGL 自己渲染玻璃效果，系统毛玻璃会叠白色底
    // vibrancy: isMac ? 'under-window' : undefined,
    // visualEffectState: isMac ? 'active' : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(__dirname, 'preload.cjs'),
    },
  });

  if (IS_DEV) {
    void mainWindow.loadURL(VITE_DEV_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(resolve(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on(
  'window:resize',
  (_e, payload: { width: number; height: number }) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    const { width: screenW, height: screenH } =
      screen.getPrimaryDisplay().workAreaSize;
    // 以右下角为锚点做 resize，让 pet ↔ chat 切换不会跳到屏幕另一侧
    const anchorRight = x + w;
    const anchorBottom = y + h;
    let newX = anchorRight - payload.width;
    let newY = anchorBottom - payload.height;
    newX = Math.max(8, Math.min(newX, screenW - payload.width - 8));
    newY = Math.max(8, Math.min(newY, screenH - payload.height - 8));
    mainWindow.setBounds(
      { x: newX, y: newY, width: payload.width, height: payload.height },
      true,
    );
  },
);

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
