const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  resize: (width, height, anchor, animate) =>
    ipcRenderer.send('window:resize', {
      width,
      height,
      anchor: anchor || 'bottom-right',
      animate: !!animate,
    }),
  startResize: (direction) =>
    ipcRenderer.send('window:start-resize', direction),
  openTeamPanel: () => ipcRenderer.send('window:open-team-panel'),
  openSettings: () => ipcRenderer.send('window:open-settings'),
});
