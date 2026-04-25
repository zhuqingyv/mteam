// Electron 主进程：透明无边框窗口 + CSS 毛玻璃。
// 初始 250x100（收起态小卡片），展开态 renderer 通过 window:resize IPC 请求。
import { app, BrowserWindow, ipcMain, screen, nativeImage } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';

const ICON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;

const PET_SIZE = { width: 380, height: 120 };

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
    icon: nativeImage.createFromPath(ICON_PATH),
    transparent: true,
    frame: false,
    hasShadow: false,
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

ipcMain.on('window:start-resize', (_e, direction: string) => {
  if (!mainWindow) return;
  mainWindow.webContents.send('resize-started');
  const dirMap: Record<string, string> = {
    top: 'top', bottom: 'bottom', left: 'left', right: 'right',
    tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right',
  };
  const mapped = dirMap[direction];
  if (mapped) {
    // @ts-ignore - Electron 内置 resize 拖拽 API（Electron 22+）
    mainWindow.startResizing?.(mapped);
  }
});

ipcMain.on(
  'window:resize',
  (
    _e,
    payload: { width: number; height: number; anchor?: string; animate?: boolean },
  ) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();

    let newX = x;
    let newY = y;

    if (payload.anchor === 'bottom-right') {
      newX = x + w - payload.width;
      newY = y + h - payload.height;
    }

    const { width: screenW, height: screenH } =
      screen.getPrimaryDisplay().workAreaSize;
    newX = Math.max(8, Math.min(newX, screenW - payload.width - 8));
    newY = Math.max(8, Math.min(newY, screenH - payload.height - 8));

    mainWindow.setBounds(
      { x: newX, y: newY, width: payload.width, height: payload.height },
      payload.animate ?? false,
    );
  },
);

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
  }
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
