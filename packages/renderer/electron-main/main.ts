// Electron 主进程入口：启动 backend 子进程 + 创建 BrowserWindow。
// 开发模式：loadURL(VITE_DEV_URL)，配合 Vite HMR。
// 生产模式：loadFile(dist/index.html)。
import { app, BrowserWindow } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'mteam',
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
    // 生产：renderer/dist/index.html
    void mainWindow.loadFile(resolve(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
