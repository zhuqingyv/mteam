import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('terminalBridge', {
  // Main → renderer: PTY output
  onPtyOutput: (cb: (data: string) => void) => {
    ipcRenderer.on('pty-output', (_event, data: string) => cb(data))
  },

  // Renderer → main: keyboard input
  sendInput: (data: string) => {
    ipcRenderer.send('terminal-input', data)
  },

  // Renderer → main: terminal ready + initial dimensions
  notifyReady: (cols: number, rows: number) => {
    ipcRenderer.send('terminal-ready', cols, rows)
  },

  // Renderer → main: dimensions changed
  notifyResize: (cols: number, rows: number) => {
    ipcRenderer.send('terminal-resize', cols, rows)
  }
})
