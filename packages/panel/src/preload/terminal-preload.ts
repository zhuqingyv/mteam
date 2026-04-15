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
  },

  // Get member color [R, G, B] for liquid border
  getMemberColor: (): Promise<number[]> => {
    return ipcRenderer.invoke('get-member-color')
  },

  // Get member name for titlebar
  getMemberName: (): Promise<string> => {
    return ipcRenderer.invoke('get-member-name')
  },

  // Close this terminal window
  closeWindow: () => {
    ipcRenderer.send('close-terminal-window')
  }
})
