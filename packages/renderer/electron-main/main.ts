// Electron 主进程：桌宠主窗口 + 团队面板/设置副窗口（query param 区分）。
import { app, BrowserWindow, ipcMain, screen, nativeImage } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackendAndWait } from './backend.js';

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
let roleListWindow: BrowserWindow | null = null;

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
  // 防重复：boot 和 activate 路径都可能调到这里
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
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

type PanelKey = 'team' | 'settings' | 'roles';

function openPanel(key: PanelKey): void {
  const cfg = key === 'team'
    ? { ref: teamPanelWindow, w: 1200, h: 800, minW: 800, minH: 600, title: 'mteam — 团队面板', q: '?window=team' }
    : key === 'settings'
      ? { ref: settingsWindow, w: 800, h: 640, minW: 640, minH: 480, title: 'mteam — 设置', q: '?window=settings' }
      : { ref: roleListWindow, w: 800, h: 640, minW: 640, minH: 480, title: 'mteam — 成员管理', q: '?window=roles' };
  // stale ref 保险：on('closed') 已置 null，但防止异步时序或异常路径留下的已 destroy ref
  if (cfg.ref && cfg.ref.isDestroyed()) {
    if (key === 'team') teamPanelWindow = null;
    else if (key === 'settings') settingsWindow = null;
    else roleListWindow = null;
    cfg.ref = null;
  }
  if (cfg.ref && !cfg.ref.isDestroyed()) {
    if (key === 'team') {
      const now = Date.now();
      if (now - lastTeamOpenAt < TEAM_OPEN_DEBOUNCE_MS) return;
      lastTeamOpenAt = now;
      cfg.ref.focus();
    } else if (key === 'roles') {
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
  if (key === 'team') teamPanelWindow = win;
  else if (key === 'settings') settingsWindow = win;
  else roleListWindow = win;
  loadRenderer(win, cfg.q);
  win.on('closed', () => {
    if (key === 'team') teamPanelWindow = null;
    else if (key === 'settings') settingsWindow = null;
    else roleListWindow = null;
  });
}
ipcMain.on('window:open-team-panel', () => openPanel('team'));
ipcMain.on('window:open-settings', () => openPanel('settings'));
ipcMain.on('window:open-role-list', () => openPanel('roles'));

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

// 单实例锁：macOS 上多次 `bun run start` 会起多个 Electron 进程，
// 导致桌面出现两个胶囊。拿不到锁的直接退出，已经在跑的那个聚焦主窗。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
  // 不在这里 stopBackend —— 让 before-quit 统一处理，避免双路径 race。
  app.quit();
});

// before-quit 用 preventDefault + 异步等后端退出，确保 Cmd+Q 不留孤儿 bun/agent driver。
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void stopBackendAndWait().finally(() => app.exit(0));
});

// 最终保险：quit 事件后强制退出，任何遗漏的 node-pty / timer 都不影响进程终止。
app.on('quit', () => process.exit(0));
