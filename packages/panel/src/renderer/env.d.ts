/// <reference types="vite/client" />

interface MemberStatus {
  uid: string
  name: string
  role: string
  type: 'permanent' | 'temporary'
  status: 'reserved' | 'working' | 'offline' | 'pending_departure'
  busy: boolean
  project?: string
  task?: string
  caller?: string
  lockedAt?: string
  lastSeen?: string
  lastTool?: string
}

interface SessionFile {
  pid: number
  lstart: string
  cwd: string
  started_at: string
}

interface TeamStatus {
  sessions: SessionFile[]
  members: MemberStatus[]
  scannedAt: string
  healthy: boolean
  errorMsg?: string
}

interface WorkLogEntry {
  event: string
  timestamp: string
  project: string
  task?: string
  note?: string
}

interface MemberDetail {
  profile: {
    uid: string
    name: string
    role: string
    type: 'permanent' | 'temporary'
    joined_at: string
  }
  persona: string | null
  memory: string | null
  workLog: WorkLogEntry[]
  status: 'reserved' | 'working' | 'offline' | 'pending_departure'
  busy: boolean
  project?: string
  task?: string
  caller?: string
  lockedAt?: string
  lastSeen?: string
  lastTool?: string
}

interface StoreMcpItem {
  name: string
  command: string
  args: string[]
  description?: string
}

interface McpStoreData {
  store: StoreMcpItem[]
  memberMounts: { member: string; name: string; mcps: string[] }[]
}

interface RegistryPackage {
  registryType: string
  identifier: string
  version: string
  runtimeHint?: string
  transport?: { type: string }
  environmentVariables?: { name: string; description?: string; isSecret?: boolean; default?: string }[]
}

interface RegistryServer {
  name: string
  title?: string
  description: string
  version: string
  repository?: { url: string; source: string }
  websiteUrl?: string
  packages: RegistryPackage[]
}

interface RegistryItem {
  server: RegistryServer
  _meta: Record<string, unknown>
}

interface RegistryData {
  servers: RegistryItem[]
  metadata: { count: number }
}

type ProjectStatus = 'planning' | 'designing' | 'developing' | 'testing' | 'bugfixing' | 'done' | 'abandoned'

interface ProjectData {
  id: string
  name: string
  description: string
  status: ProjectStatus
  progress: number
  members: string[]
  experience: string
  forbidden: string[]
  rules: string[]
  created_at: string
  updated_at: string
}

interface Window {
  overlayBridge: {
    onWindowPositions: (cb: (positions: Array<{
      id: number
      memberName: string
      x: number
      y: number
      w: number
      h: number
      color: number[]
    }>) => void) => void
    onMessageEvents: (cb: (messages: Array<{
      from: string
      to: string
      startTime: number
      duration: number
    }>) => void) => void
  }
  api: {
    scanAgentClis: (force?: boolean) => Promise<{ found: { name: string; bin: string; version: string; status: string }[] }>
    selectDirectory: () => Promise<{ canceled: boolean; path: string | null }>
    launchMember: (opts: {
      memberName: string
      cliBin: string
      cliName: string
      isLeader?: boolean
      workspacePath?: string
    }) => Promise<{ ok: boolean; reason?: string; winId?: number; workspacePath?: string }>
    trustWorkspace: (workspacePath: string) => Promise<{ ok: boolean; reason?: string }>
  }
  teamHub: {
    onStatusUpdate: (callback: (status: TeamStatus) => void) => () => void
    getInitialStatus: () => Promise<TeamStatus>
    getMemberDetail: (memberName: string) => Promise<MemberDetail | null>
    getMcpStore: () => Promise<McpStoreData>
    getRegistry: (query?: string) => Promise<RegistryData>
    installStoreMcp: (item: { name: string; command: string; args: string[]; description?: string }) => Promise<{ ok: boolean; reason?: string }>
    uninstallStoreMcp: (name: string) => Promise<{ ok: boolean; reason?: string }>
    mountMemberMcp: (memberName: string, mcpName: string) => Promise<{ ok: boolean; reason?: string }>
    unmountMemberMcp: (memberName: string, mcpName: string) => Promise<{ ok: boolean; reason?: string }>
    getMemberMcps: (memberName: string) => Promise<StoreMcpItem[]>
    listProjects: () => Promise<ProjectData[]>
    getProject: (id: string) => Promise<ProjectData | null>
    createProject: (data: Omit<ProjectData, 'id' | 'created_at' | 'updated_at'>) => Promise<ProjectData>
    updateProject: (id: string, patch: Partial<ProjectData>) => Promise<ProjectData | null>
    deleteProject: (id: string) => Promise<boolean>
    getMemberProjects: (memberName: string) => Promise<ProjectData[]>
    getTheme: () => Promise<'dark' | 'light'>
    onThemeChange: (callback: (theme: 'dark' | 'light') => void) => () => void
  }
}
