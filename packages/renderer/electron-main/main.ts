// Electron 主进程：桌宠主窗口 + 团队面板/设置副窗口（query param 区分）。
import { app, BrowserWindow, ipcMain, screen, nativeImage } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICON_PATH = resolve(__dirname, '..', 'build', 'icon.png');
const VITE_DEV_URL = process.env.VITE_DEV_URL;
const IS_DEV = !!VITE_DEV_URL;
const PET_SIZE = { width: 380, height: 120 };

// dev 模式开启 CDP，便于 e2e 通过 Chrome DevTools Protocol 连接。
// MTEAM_CDP_PORT 可覆盖默认端口，用于多 agent 并行 CDP 验证时避让冲突。
if (IS_DEV) {
  const CDP_PORT = process.env.MTEAM_CDP_PORT || '9222';
  app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

let mainWindow: BrowserWindow | null = null;
let teamPanelWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

const baseGlassOptions = {
  transparent: true,
  frame: false,
  hasShadow: false,
  backgroundColor: '#00000000',
  resizable: true,
  icon: nativeImage.createFromPath(ICON_PATH),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: resolve(__dirname, 'preload.cjs'),
  },
} as const;

function loadRenderer(win: BrowserWindow, query = ''): void {
  if (IS_DEV) {
    void win.loadURL(VITE_DEV_URL! + query);
  } else {
    void win.loadFile(resolve(__dirname, '..', 'dist', 'index.html'), {
      search: query.replace(/^\?/, ''),
    });
  }
}

function createWindow(): void {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    ...baseGlassOptions,
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: Math.round(screenW - PET_SIZE.width - 40),
    y: Math.round(screenH - PET_SIZE.height - 80),
    title: 'mteam',
    alwaysOnTop: true,
  });
  loadRenderer(mainWindow);
  let moveIdleTimer: ReturnType<typeof setTimeout> | null = null;
  mainWindow.on('move', () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('window:drag-start');
    if (moveIdleTimer) clearTimeout(moveIdleTimer);
    moveIdleTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window:drag-end');
      }
    }, 120);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// team 面板由 WS team.created 自动唤起，500ms 内多次触发去重。
let lastTeamOpenAt = 0;
const TEAM_OPEN_DEBOUNCE_MS = 500;

function openPanel(key: 'team' | 'settings'): void {
  const cfg = key === 'team'
    ? { ref: teamPanelWindow, w: 1200, h: 800, minW: 800, minH: 600, title: 'mteam — 团队面板', q: '?window=team' }
    : { ref: settingsWindow, w: 600, h: 500, minW: 400, minH: 300, title: 'mteam — 设置', q: '?window=settings' };
  // stale ref 保险：on('closed') 已置 null，但防止异步时序或异常路径留下的已 destroy ref
  if (cfg.ref && cfg.ref.isDestroyed()) {
    if (key === 'team') teamPanelWindow = null;
    else settingsWindow = null;
    cfg.ref = null;
  }
  if (cfg.ref && !cfg.ref.isDestroyed()) {
    if (key === 'team') {
      const now = Date.now();
      if (now - lastTeamOpenAt < TEAM_OPEN_DEBOUNCE_MS) return;
      lastTeamOpenAt = now;
      cfg.ref.focus();
    } else {
      cfg.ref.close();
    }
    return;
  }
  if (key === 'team') lastTeamOpenAt = Date.now();
  const win = new BrowserWindow({
    ...baseGlassOptions,
    width: cfg.w,
    height: cfg.h,
    minWidth: cfg.minW,
    minHeight: cfg.minH,
    title: cfg.title,
  });
  if (key === 'team') teamPanelWindow = win; else settingsWindow = win;
  loadRenderer(win, cfg.q);
  win.on('closed', () => { if (key === 'team') teamPanelWindow = null; else settingsWindow = null; });
}
ipcMain.on('window:open-team-panel', () => openPanel('team'));
ipcMain.on('window:open-settings', () => openPanel('settings'));

const RESIZE_DIR_MAP: Record<string, string> = {
  top: 'top', bottom: 'bottom', left: 'left', right: 'right',
  tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right',
};
ipcMain.on('window:start-resize', (_e, direction: string) => {
  if (!mainWindow) return;
  mainWindow.webContents.send('resize-started');
  const mapped = RESIZE_DIR_MAP[direction];
  // @ts-ignore - Electron 内置 resize 拖拽 API（Electron 22+）
  if (mapped) mainWindow.startResizing?.(mapped);
});

ipcMain.on('window:resize', (_e, payload: { width: number; height: number; anchor?: string; animate?: boolean }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  let newX = x;
  let newY = y;
  if (payload.anchor === 'bottom-right') {
    newX = x + w - payload.width;
    newY = y + h - payload.height;
  }
  // 以窗口当前所在屏幕为锚点 clamp，避免跨屏时被挤回主屏
  const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  newX = Math.max(wa.x + 8, Math.min(newX, wa.x + wa.width - payload.width - 8));
  newY = Math.max(wa.y + 8, Math.min(newY, wa.y + wa.height - payload.height - 8));
  mainWindow.setBounds(
    { x: newX, y: newY, width: payload.width, height: payload.height },
    payload.animate ?? false,
  );
});

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
  app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
