// Preload：暴露窗口 resize + 壁纸 dataURL + 窗口 rect 订阅给 renderer。
// .cjs 让 Electron 走 CommonJS，避免跟 renderer 的 ESM 冲突。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  resize: (width, height) =>
    ipcRenderer.send('window:resize', { width, height }),

  // 启动时主动拉：{ dataUrl, rect }
  getInitialFrame: () => ipcRenderer.invoke('get-initial-frame'),

  // 壁纸换了才推，30s 轮询触发
  onWallpaperUpdate: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('wallpaper-update', handler);
    return () => ipcRenderer.removeListener('wallpaper-update', handler);
  },

  // 窗口 move/resize 时 60fps 推 bounds
  onWindowRect: (cb) => {
    const handler = (_event, rect) => cb(rect);
    ipcRenderer.on('window-rect', handler);
    return () => ipcRenderer.removeListener('window-rect', handler);
  },
});
