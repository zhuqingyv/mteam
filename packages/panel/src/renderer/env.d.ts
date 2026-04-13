/// <reference types="vite/client" />

interface MemberStatus {
  name: string
  callName: string
  role: string
  type: 'permanent' | 'temporary'
  busy: boolean
  project?: string
  task?: string
  lockedAt?: string
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

interface Window {
  teamHub: {
    onStatusUpdate: (callback: (status: TeamStatus) => void) => () => void
    getInitialStatus: () => Promise<TeamStatus>
    getTheme: () => Promise<'dark' | 'light'>
    onThemeChange: (callback: (theme: 'dark' | 'light') => void) => () => void
  }
}
