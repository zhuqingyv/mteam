import { contextBridge, ipcRenderer } from 'electron'

// Receive display identity from main process (sent on dom-ready)
ipcRenderer.on('init-display', (_e, displayId: number, dpr: number, originX: number, originY: number) => {
  (window as any).__overlayDisplayId = displayId;
  (window as any).__overlayDpr = dpr;
  (window as any).__overlayOriginX = originX;
  (window as any).__overlayOriginY = originY
})

contextBridge.exposeInMainWorld('overlayBridge', {
  onWindowPositions: (cb: (positions: any[]) => void) => {
    ipcRenderer.on('window-positions', (_e, positions) => cb(positions))
  },
  onMessageEvents: (cb: (messages: any[]) => void) => {
    ipcRenderer.on('message-events', (_e, messages) => cb(messages))
  }
})
