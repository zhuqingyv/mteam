// Preload：只暴露 window resize 给 renderer。
// .cjs 让 Electron 走 CommonJS，避免跟 renderer 的 ESM 冲突。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  resize: (width, height) =>
    ipcRenderer.send('window:resize', { width, height }),
});
