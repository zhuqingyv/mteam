import { contextBridge, ipcRenderer } from 'electron'
import type { TeamStatus, MemberDetail, McpStoreData, RegistryData, ProjectData } from '../main/index'
import type { PtySession, SpawnOptions, SpawnResult } from '../main/pty-manager'

contextBridge.exposeInMainWorld('teamHub', {
  onStatusUpdate: (callback: (status: TeamStatus) => void) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status))
    return () => { ipcRenderer.removeAllListeners('status-update') }
  },
  getInitialStatus: (): Promise<TeamStatus> => {
    return ipcRenderer.invoke('get-initial-status')
  },
  getMemberDetail: (memberName: string): Promise<MemberDetail | null> => {
    return ipcRenderer.invoke('get-member-detail', memberName)
  },
  getMcpStore: (): Promise<McpStoreData> => {
    return ipcRenderer.invoke('get-mcp-store')
  },
  getRegistry: (query?: string): Promise<RegistryData> => {
    return ipcRenderer.invoke('get-registry', query)
  },
  installStoreMcp: (item: { name: string; command: string; args: string[]; description?: string }): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('install-store-mcp', item)
  },
  uninstallStoreMcp: (name: string): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('uninstall-store-mcp', name)
  },
  mountMemberMcp: (memberName: string, mcpName: string): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('mount-member-mcp', memberName, mcpName)
  },
  unmountMemberMcp: (memberName: string, mcpName: string): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('unmount-member-mcp', memberName, mcpName)
  },
  getMemberMcps: (memberName: string): Promise<{ name: string; command: string; args: string[]; description?: string }[]> => {
    return ipcRenderer.invoke('get-member-mcps', memberName)
  },
  listProjects: (): Promise<ProjectData[]> => ipcRenderer.invoke('list-projects'),
  getProject: (id: string): Promise<ProjectData | null> => ipcRenderer.invoke('get-project', id),
  createProject: (data: Omit<ProjectData, 'id' | 'created_at' | 'updated_at'>): Promise<ProjectData> => ipcRenderer.invoke('create-project', data),
  updateProject: (id: string, patch: Partial<ProjectData>): Promise<ProjectData | null> => ipcRenderer.invoke('update-project', id, patch),
  deleteProject: (id: string): Promise<boolean> => ipcRenderer.invoke('delete-project', id),
  getMemberProjects: (memberName: string): Promise<ProjectData[]> => ipcRenderer.invoke('get-member-projects', memberName),
  getTheme: (): Promise<'dark' | 'light'> => {
    return ipcRenderer.invoke('get-theme')
  },
  onThemeChange: (callback: (theme: 'dark' | 'light') => void) => {
    ipcRenderer.on('theme-change', (_event, theme) => callback(theme))
    return () => { ipcRenderer.removeAllListeners('theme-change') }
  }
})

// ── window.api — used by LeadModal ────────────────────────────────────────────
contextBridge.exposeInMainWorld('api', {
  scanAgentClis: (force?: boolean) => {
    return ipcRenderer.invoke('scan-agent-clis', force)
  },
  selectDirectory: (): Promise<{ canceled: boolean; path: string | null }> => {
    return ipcRenderer.invoke('select-directory')
  },
  launchMember: (opts: {
    memberName: string
    displayName: string
    cliBin: string
    cliName: string
    isLeader?: boolean
    workspacePath?: string
  }) => {
    return ipcRenderer.invoke('launch-member', opts)
  },
  trustWorkspace: (workspacePath: string): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('trust-workspace', workspacePath)
  }
})

// ── window.ptyBridge — PTY session management ────────────────────────────────
contextBridge.exposeInMainWorld('ptyBridge', {
  // Session lifecycle
  spawn: (opts: SpawnOptions): Promise<SpawnResult> => {
    return ipcRenderer.invoke('spawn-pty-session', opts)
  },
  write: (sessionId: string, data: string): Promise<boolean> => {
    return ipcRenderer.invoke('write-to-pty', sessionId, data)
  },
  resize: (sessionId: string, cols: number, rows: number): Promise<boolean> => {
    return ipcRenderer.invoke('resize-pty', sessionId, cols, rows)
  },
  kill: (sessionId: string): Promise<boolean> => {
    return ipcRenderer.invoke('kill-pty-session', sessionId)
  },

  // Query
  list: (): Promise<PtySession[]> => {
    return ipcRenderer.invoke('get-pty-sessions')
  },
  get: (sessionId: string): Promise<PtySession | null> => {
    return ipcRenderer.invoke('get-pty-session', sessionId)
  },
  getBuffer: (sessionId: string): Promise<string | null> => {
    return ipcRenderer.invoke('get-pty-buffer', sessionId)
  },

  // Window binding — binds this window to receive pty-output/pty-exit for this session
  attach: (sessionId: string): Promise<{ ok: true; buffer: string } | { ok: false; reason: string }> => {
    return ipcRenderer.invoke('attach-pty-window', sessionId)
  },

  // Events from main process
  onOutput: (callback: (sessionId: string, data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('pty-output', handler)
    return () => { ipcRenderer.removeListener('pty-output', handler) }
  },
  onExit: (callback: (sessionId: string, exitCode: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number) => callback(sessionId, exitCode)
    ipcRenderer.on('pty-exit', handler)
    return () => { ipcRenderer.removeListener('pty-exit', handler) }
  }
})
