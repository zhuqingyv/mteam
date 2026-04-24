// Preload：暴露窗口 resize 能力给 renderer，用于 pet 态 ↔ chat 态切换。
// 用 .cjs 显式告诉 Electron 走 CommonJS，避免和 renderer 的 ESM 冲突。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  resize: (width, height) => ipcRenderer.send('window:resize', { width, height }),
});
