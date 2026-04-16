import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('askUserBridge', {
  // Main → Renderer: receive request data
  onShowRequest: (cb: (request: unknown) => void) => {
    ipcRenderer.on('show-ask-user', (_event, request: unknown) => cb(request))
  },

  // Renderer → Main: get request data (fallback if show-ask-user fired before renderer ready)
  getRequest: (): Promise<unknown> => {
    return ipcRenderer.invoke('ask-user-get-request')
  },

  // Renderer → Main: submit answer
  submitResponse: (requestId: string, response: { choice?: string | string[]; input?: string }) => {
    ipcRenderer.send('ask-user-response', requestId, response)
  },

  // Renderer → Main: cancel
  cancel: (requestId: string) => {
    ipcRenderer.send('ask-user-cancel', requestId)
  },
})
