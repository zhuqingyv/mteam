import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlayBridge', {
  onWindowPositions: (cb: (positions: any[]) => void) => {
    ipcRenderer.on('window-positions', (_e, positions) => cb(positions))
  },
  onMessageEvents: (cb: (messages: any[]) => void) => {
    ipcRenderer.on('message-events', (_e, messages) => cb(messages))
  }
})
