import { contextBridge, ipcRenderer } from 'electron'
import type { TeamStatus } from '../main/index'

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('teamHub', {
  onStatusUpdate: (callback: (status: TeamStatus) => void) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status))
    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeAllListeners('status-update')
    }
  },
  getInitialStatus: (): Promise<TeamStatus> => {
    return ipcRenderer.invoke('get-initial-status')
  },
  getTheme: (): Promise<'dark' | 'light'> => {
    return ipcRenderer.invoke('get-theme')
  },
  onThemeChange: (callback: (theme: 'dark' | 'light') => void) => {
    ipcRenderer.on('theme-change', (_event, theme) => callback(theme))
    return () => {
      ipcRenderer.removeAllListeners('theme-change')
    }
  }
})
