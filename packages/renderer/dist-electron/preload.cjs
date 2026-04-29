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
  openRoleList: () => ipcRenderer.send('window:open-role-list'),
  startDrag: (screenX, screenY) =>
    ipcRenderer.send('window:start-drag', { screenX, screenY }),
  dragMove: (screenX, screenY) =>
    ipcRenderer.send('window:drag-move', { screenX, screenY }),
  onDragStart: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('window:drag-start', listener);
    return () => ipcRenderer.removeListener('window:drag-start', listener);
  },
  onDragEnd: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('window:drag-end', listener);
    return () => ipcRenderer.removeListener('window:drag-end', listener);
  },
});
