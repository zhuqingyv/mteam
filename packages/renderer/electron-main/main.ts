// Electron 主进程：透明无边框窗口 + CSS 毛玻璃。
// 初始 250x100（收起态小卡片），展开态 renderer 通过 window:resize IPC 请求。
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;

const PET_SIZE = { width: 250, height: 100 };

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(__dirname, 'preload.cjs'),
    },
  });

  if (IS_DEV) {
    void mainWindow.loadURL(VITE_DEV_URL!);
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
