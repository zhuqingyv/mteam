import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell
} from 'electron'
import { join, resolve, dirname } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, closeSync } from 'fs'
import { execSync, spawn } from 'child_process'
import chokidar, { FSWatcher } from 'chokidar'
import { scanAgentClis } from './agent-cli-scanner'
import { openTerminalWindow, setupTerminalIpc } from './terminal-window'
import {
  spawnPtySession,
  writeToPty,
  resizePty,
  killPtySession,
  getPtySessions,
  getPtySession,
  getPtyBuffer,
  killAllPtySessions,
  attachWindow,
  type SpawnOptions
} from './pty-manager'
import { setupMessageRouter, teardownMessageRouter } from './message-router'
import { startPanelApi, stopPanelApi, setMessageRouter } from './panel-api'
import { createOverlay } from './overlay-window'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const TEAM_HUB_DIR = resolve(homedir(), '.claude/team-hub')
const SESSIONS_DIR = join(TEAM_HUB_DIR, 'sessions')
const MEMBERS_DIR = join(TEAM_HUB_DIR, 'members')
const SHARED_DIR = join(TEAM_HUB_DIR, 'shared')
const PROJECTS_DIR = join(SHARED_DIR, 'projects')

// ── 类型 ──────────────────────────────────────────────────────────────────────
interface SessionFile {
  pid: number
  lstart: string
  cwd: string
  started_at: string
}

interface LockFile {
  nonce: string
  // 注意：字段名是 session_pid 不是 pid（历史上曾用 pid，已统一为 session_pid）
  session_pid: number
  session_start: string
  project: string
  task: string
  locked_at: string
}

interface HeartbeatFile {
  last_seen: string
  last_seen_ms: number
  session_pid: number
  last_tool: string
}

interface ReservationFile {
  code: string
  caller: string
  project: string
  task: string
  created_at: number
  ttl_ms: number
}

interface ProfileFile {
  uid: string
  name: string
  role: string
  type: 'permanent' | 'temporary'
  joined_at: string
}

export interface MemberStatus {
  uid: string
  name: string
  role: string
  type: 'permanent' | 'temporary'
  /** 三态：reserved=已预约待激活, working=有锁或PTY运行, offline=其余 */
  status: 'reserved' | 'working' | 'offline'
  /** 向后兼容 */
  busy: boolean
  project?: string
  task?: string
  /** 预约方（仅 reserved 状态时有值） */
  caller?: string
  lockedAt?: string
  lastSeen?: string
  lastTool?: string
}

export interface TeamStatus {
  sessions: SessionFile[]
  members: MemberStatus[]
  scannedAt: string
  healthy: boolean
  errorMsg?: string
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function readJson<T>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程存在但无权发信号，视为存活
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

function getPidLstart(pid: number): string | null {
  try {
    const result = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 2000 })
    return result.trim()
  } catch {
    return null
  }
}

// ── 扫描活跃 Claude 进程 ─────────────────────────────────────────────────────
function scanClaudeProcesses(): SessionFile[] {
  try {
    const output = execSync('ps -eo pid,lstart,command', { encoding: 'utf-8', timeout: 3000 })
    const sessions: SessionFile[] = []
    for (const line of output.split('\n')) {
      // 匹配 claude 主进程（排除 helper、agent 等子进程）
      if (!/\bclaude\b/.test(line) || /Helper|agent|electron|node /i.test(line)) continue
      const match = line.trim().match(/^(\d+)\s+(.+?\d{4})\s+(.+)$/)
      if (!match) continue
      const pid = parseInt(match[1], 10)
      const lstart = match[2].trim()
      const cmd = match[3].trim()
      if (!cmd.includes('claude')) continue
      sessions.push({ pid, lstart, cwd: '', started_at: '' })
    }
    return sessions
  } catch {
    return []
  }
}

// ── 数据扫描 ──────────────────────────────────────────────────────────────────
function scanTeamStatus(): TeamStatus {
  const scannedAt = new Date().toISOString()
  let errorMsg: string | undefined

  // 直接扫描系统 claude 进程，不依赖 session 文件
  const sessionFiles = scanClaudeProcesses()

  // 确保成员目录存在
  if (!existsSync(MEMBERS_DIR)) {
    return { sessions: sessionFiles, members: [], scannedAt, healthy: true }
  }

  // 扫描 members
  const members: MemberStatus[] = []
  try {
    const memberDirs = readdirSync(MEMBERS_DIR).filter((d) => {
      const p = join(MEMBERS_DIR, d)
      return statSync(p).isDirectory()
    })

    for (const memberDir of memberDirs) {
      const profilePath = join(MEMBERS_DIR, memberDir, 'profile.json')
      const lockPath = join(MEMBERS_DIR, memberDir, 'lock.json')
      const heartbeatPath = join(MEMBERS_DIR, memberDir, 'heartbeat.json')

      const profile = readJson<ProfileFile>(profilePath)
      if (!profile) continue

      const lock = readJson<LockFile>(lockPath)
      const heartbeat = readJson<HeartbeatFile>(heartbeatPath)
      const reservationPath = join(MEMBERS_DIR, memberDir, 'reservation.json')
      let reservation = readJson<ReservationFile>(reservationPath)
      // TTL 检查：过期则标记为无效（不删文件，由 service 层清理）
      const hasReservation = reservation !== null
        && (Date.now() - reservation.created_at <= reservation.ttl_ms)

      // 三态判定：working → reserved → offline
      let status: 'reserved' | 'working' | 'offline'
      if (lock) {
        status = 'working'
      } else {
        const ptySession = getPtySessions().find((s) => s.memberId === memberDir && s.status === 'running')
        if (ptySession) {
          status = 'working'
        } else if (hasReservation) {
          status = 'reserved'
        } else {
          status = 'offline'
        }
      }

      members.push({
        uid: profile.uid ?? memberDir,
        name: profile.name,
        role: profile.role,
        type: profile.type,
        status,
        busy: status === 'working',
        project: lock?.project ?? reservation?.project,
        task: lock?.task ?? reservation?.task,
        caller: reservation?.caller,
        lockedAt: lock?.locked_at,
        lastSeen: heartbeat?.last_seen,
        lastTool: heartbeat?.last_tool
      })
    }
  } catch (e) {
    errorMsg = errorMsg ? errorMsg + '; ' + String(e) : String(e)
  }

  return {
    sessions: sessionFiles,
    members,
    scannedAt,
    healthy: !errorMsg,
    errorMsg
  }
}

// ── Session 巡检（清理死进程的 session 和 lock）─────────────────────────────
function inspectSessions(): void {
  // 1. 只读巡检 session 文件（不清理，仅记录状态）
  if (existsSync(SESSIONS_DIR)) {
    let files: string[]
    try {
      files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }

    for (const file of files) {
      const sessionPath = join(SESSIONS_DIR, file)
      const session = readJson<SessionFile>(sessionPath)
      if (!session) continue

      if (isPidAlive(session.pid)) continue

      // 进程不存在，用 lstart 双验（只读检测，不删文件）
      const lstart = getPidLstart(session.pid)
      if (lstart && lstart === session.lstart) continue

      // 死进程 session 检测到但不清理，由 service 层负责
    }
  }

  // 2. 只读巡检所有成员 lock.json，检测孤儿锁（不清理）
  //    不依赖 session 文件，直接检查 lock 中的 session_pid 是否存活
  if (!existsSync(MEMBERS_DIR)) return
  let memberDirs: string[]
  try {
    memberDirs = readdirSync(MEMBERS_DIR).filter((d) => {
      return statSync(join(MEMBERS_DIR, d)).isDirectory()
    })
  } catch {
    return
  }

  for (const memberDir of memberDirs) {
    const lockPath = join(MEMBERS_DIR, memberDir, 'lock.json')
    const heartbeatPath = join(MEMBERS_DIR, memberDir, 'heartbeat.json')
    const lock = readJson<LockFile>(lockPath)
    if (!lock) continue

    // 策略1：进程死亡 → 检测到孤儿锁（不清理，由 service 层负责）
    if (!isPidAlive(lock.session_pid)) {
      continue
    }

    // 策略2：进程存在但 PID 复用（lstart 不匹配）→ 检测到（不清理）
    const lstart = getPidLstart(lock.session_pid)
    if (lstart && lstart !== lock.session_start) {
      continue
    }

    // 策略3：进程存活且 lstart 匹配，但心跳超时 → 仅标记（不清理心跳文件）
    // 心跳超时说明 agent 暂时没调 MCP 工具，不代表已退出
  }
}

// ── 主窗口 ────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let autoQuitTimer: ReturnType<typeof setTimeout> | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 520,
    minWidth: 280,
    minHeight: 400,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── 推送状态到渲染进程 ────────────────────────────────────────────────────────
function pushStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const status = scanTeamStatus()
  mainWindow.webContents.send('status-update', status)

  // 自关逻辑
  if (status.sessions.length === 0) {
    if (!autoQuitTimer) {
      autoQuitTimer = setTimeout(() => {
        // 15s 后再扫一次
        const check = scanTeamStatus()
        if (check.sessions.length === 0) {
          app.quit()
        } else {
          autoQuitTimer = null
        }
      }, 15000)
    }
  } else {
    // 有新 session，取消自关
    if (autoQuitTimer) {
      clearTimeout(autoQuitTimer)
      autoQuitTimer = null
    }
  }
}

// ── 文件监听 ──────────────────────────────────────────────────────────────────
let watcherDebounce: ReturnType<typeof setTimeout> | null = null

function startWatcher(): void {
  if (watcher) return
  if (!existsSync(TEAM_HUB_DIR)) return

  watcher = chokidar.watch(TEAM_HUB_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3
  })

  watcher.on('all', () => {
    // 防抖：多个文件变动合并为一次 pushStatus（300ms 窗口）
    if (watcherDebounce) clearTimeout(watcherDebounce)
    watcherDebounce = setTimeout(() => {
      watcherDebounce = null
      pushStatus()
    }, 300)
  })

  watcher.on('error', (err) => {
    process.stderr?.write?.(`[watcher] error: ${err}\n`)
  })
}

function stopWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

// ── 轮询（每5s，合并 session 巡检）──────────────────────────────────────────
function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    inspectSessions()
    pushStatus()
  }, 5000)
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// ── 休眠/唤醒 ────────────────────────────────────────────────────────────────
let resumeTimer: ReturnType<typeof setTimeout> | null = null

function setupPowerMonitor(): void {
  powerMonitor.on('suspend', () => {
    stopWatcher()
    stopPoll()
  })

  powerMonitor.on('resume', () => {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      // 全量扫描一次
      inspectSessions()
      pushStatus()
      // 恢复监听和轮询
      startWatcher()
      startPoll()
    }, 10000)
  })
}

// ── Registry（官方 MCP 仓库）────────────────────────────────────────────────
export interface RegistryPackage {
  registryType: string
  identifier: string
  version: string
  runtimeHint?: string
  transport?: { type: string }
  environmentVariables?: { name: string; description?: string; isSecret?: boolean; default?: string }[]
}

export interface RegistryServer {
  name: string
  title?: string
  description: string
  version: string
  repository?: { url: string; source: string }
  websiteUrl?: string
  packages: RegistryPackage[]
}

export interface RegistryItem {
  server: RegistryServer
  _meta: Record<string, unknown>
}

export interface RegistryData {
  servers: RegistryItem[]
  metadata: { count: number }
}

async function fetchRegistry(query?: string): Promise<RegistryData> {
  const limit = 96
  let url = `https://registry.modelcontextprotocol.io/v0.1/servers?limit=${limit}&version=latest`
  if (query) url += `&q=${encodeURIComponent(query)}`
  try {
    const resp = await fetch(url, {
      headers: { 'accept': 'application/json' }
    })
    if (!resp.ok) return { servers: [], metadata: { count: 0 } }
    return (await resp.json()) as RegistryData
  } catch {
    return { servers: [], metadata: { count: 0 } }
  }
}

// ── MCP 商店 ─────────────────────────────────────────────────────────────────
export interface StoreMcpItem {
  name: string
  command: string
  args: string[]
  description?: string
  env?: Record<string, string>
}

export interface McpStoreData {
  store: StoreMcpItem[]
  memberMounts: { member: string; name: string; mcps: string[] }[]
}

function getMcpStore(): McpStoreData {
  // 读商店
  let store: StoreMcpItem[] = []
  const storePath = join(SHARED_DIR, 'mcp_store.json')
  if (existsSync(storePath)) {
    try {
      store = JSON.parse(readFileSync(storePath, 'utf-8')) as StoreMcpItem[]
    } catch { /* ignore */ }
  }

  // 读每个成员的挂载情况
  const memberMounts: McpStoreData['memberMounts'] = []
  if (existsSync(MEMBERS_DIR)) {
    try {
      const dirs = readdirSync(MEMBERS_DIR).filter((d) => {
        return statSync(join(MEMBERS_DIR, d)).isDirectory()
      })
      for (const dir of dirs) {
        const mcpsPath = join(MEMBERS_DIR, dir, 'mcps.json')
        const profilePath = join(MEMBERS_DIR, dir, 'profile.json')
        if (!existsSync(mcpsPath)) continue
        const profile = readJson<ProfileFile>(profilePath)
        try {
          const mcps = JSON.parse(readFileSync(mcpsPath, 'utf-8')) as StoreMcpItem[]
          if (mcps.length > 0) {
            memberMounts.push({
              member: dir,
              name: profile?.name ?? dir,
              mcps: mcps.map((m) => m.name)
            })
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return { store, memberMounts }
}

// ── 成员详情 ────────────────────────────────────────────────────────────────
export interface MemberDetail {
  profile: ProfileFile
  persona: string | null
  memory: string | null
  workLog: WorkLogEntry[]
  status: 'reserved' | 'working' | 'offline'
  busy: boolean
  project?: string
  task?: string
  lockedAt?: string
  lastSeen?: string
  lastTool?: string
}

interface WorkLogEntry {
  event: string
  timestamp: string
  project: string
  task?: string
  note?: string
}

function getMemberDetail(memberName: string): MemberDetail | null {
  const memberDir = join(MEMBERS_DIR, memberName)
  if (!existsSync(memberDir)) return null

  const profile = readJson<ProfileFile>(join(memberDir, 'profile.json'))
  if (!profile) return null

  let persona: string | null = null
  const personaPath = join(memberDir, 'persona.md')
  if (existsSync(personaPath)) {
    try { persona = readFileSync(personaPath, 'utf-8') } catch { /* ignore */ }
  }

  let memory: string | null = null
  const memoryPath = join(memberDir, 'memory_generic.md')
  if (existsSync(memoryPath)) {
    try { memory = readFileSync(memoryPath, 'utf-8') } catch { /* ignore */ }
  }

  const workLog: WorkLogEntry[] = []
  const logPath = join(memberDir, 'work_log.jsonl')
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim())
      for (const line of lines) {
        try { workLog.push(JSON.parse(line) as WorkLogEntry) } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  const lock = readJson<LockFile>(join(memberDir, 'lock.json'))
  const heartbeat = readJson<HeartbeatFile>(join(memberDir, 'heartbeat.json'))
  const reservationPath2 = join(memberDir, 'reservation.json')
  const reservation2 = readJson<ReservationFile>(reservationPath2)
  // TTL 检查：过期则标记为无效（不删文件，由 service 层清理）
  const hasReservation = reservation2 !== null
    && (Date.now() - reservation2.created_at <= reservation2.ttl_ms)
  let status: 'reserved' | 'working' | 'offline'
  if (lock) {
    status = 'working'
  } else {
    const ptySession = getPtySessions().find((s) => s.memberId === memberName && s.status === 'running')
    if (ptySession) {
      status = 'working'
    } else if (hasReservation) {
      status = 'reserved'
    } else {
      status = 'offline'
    }
  }

  return {
    profile,
    persona,
    memory,
    workLog,
    status,
    busy: status === 'working',
    project: lock?.project,
    task: lock?.task,
    lockedAt: lock?.locked_at,
    lastSeen: heartbeat?.last_seen,
    lastTool: heartbeat?.last_tool
  }
}

// ── 项目管理 ────────────────────────────────────────────────────────────────
export type ProjectStatus = 'planning' | 'designing' | 'developing' | 'testing' | 'bugfixing' | 'done' | 'abandoned'

export interface ProjectData {
  id: string
  name: string
  description: string
  status: ProjectStatus
  progress: number
  members: string[]           // member names
  experience: string          // 项目经验
  forbidden: string[]         // 绝对禁止
  rules: string[]             // 绝对遵循
  created_at: string
  updated_at: string
}

function getProjectsDir(): string {
  mkdirSync(PROJECTS_DIR, { recursive: true })
  return PROJECTS_DIR
}

function listProjects(): ProjectData[] {
  const dir = getProjectsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const projects: ProjectData[] = []
  for (const file of files) {
    const p = readJson<ProjectData>(join(dir, file))
    if (p) projects.push(p)
  }
  // 活跃优先，按更新时间降序
  const statusOrder: Record<string, number> = {
    developing: 0, testing: 1, bugfixing: 2, designing: 3, planning: 4, done: 5, abandoned: 6
  }
  projects.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || b.updated_at.localeCompare(a.updated_at))
  return projects
}

function getProject(id: string): ProjectData | null {
  return readJson<ProjectData>(join(getProjectsDir(), `${id}.json`))
}

function saveProject(project: ProjectData): void {
  const dir = getProjectsDir()
  writeFileSync(join(dir, `${project.id}.json`), JSON.stringify(project, null, 2))
}

function createProject(data: Omit<ProjectData, 'id' | 'created_at' | 'updated_at'>): ProjectData {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const project: ProjectData = { id, ...data, created_at: now, updated_at: now }
  saveProject(project)
  return project
}

function updateProject(id: string, patch: Partial<Omit<ProjectData, 'id' | 'created_at'>>): ProjectData | null {
  const project = getProject(id)
  if (!project) return null
  Object.assign(project, patch, { updated_at: new Date().toISOString() })
  saveProject(project)
  return project
}

function deleteProject(id: string): boolean {
  const path = join(getProjectsDir(), `${id}.json`)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

// 获取成员参与的项目列表
function getMemberProjects(memberName: string): ProjectData[] {
  return listProjects().filter((p) => p.members.includes(memberName))
}

// ── Message Router ────────────────────────────────────────────────────────────
let messageRouter: ReturnType<typeof setupMessageRouter> | null = null

// ── IPC ───────────────────────────────────────────────────────────────────────
function setupIpc(): void {
  ipcMain.handle('get-initial-status', () => {
    return scanTeamStatus()
  })

  ipcMain.handle('get-member-detail', (_event, memberName: string) => {
    return getMemberDetail(memberName)
  })

  ipcMain.handle('get-mcp-store', () => {
    return getMcpStore()
  })

  ipcMain.handle('get-registry', (_event, query?: string) => {
    return fetchRegistry(query)
  })

  ipcMain.handle('install-store-mcp', (_event, item: StoreMcpItem) => {
    const { mkdirSync, writeFileSync } = require('fs')
    const storePath = join(SHARED_DIR, 'mcp_store.json')
    mkdirSync(SHARED_DIR, { recursive: true })
    let store: StoreMcpItem[] = []
    if (existsSync(storePath)) {
      try { store = JSON.parse(readFileSync(storePath, 'utf-8')) } catch { /* ignore */ }
    }
    if (store.some((s) => s.name === item.name)) return { ok: false, reason: '已安装' }
    store.push(item)
    writeFileSync(storePath, JSON.stringify(store, null, 2))
    return { ok: true }
  })

  ipcMain.handle('uninstall-store-mcp', (_event, name: string) => {
    const { writeFileSync } = require('fs')
    const storePath = join(SHARED_DIR, 'mcp_store.json')
    if (!existsSync(storePath)) return { ok: false, reason: '商店为空' }
    let store: StoreMcpItem[] = []
    try { store = JSON.parse(readFileSync(storePath, 'utf-8')) } catch { return { ok: false, reason: '读取失败' } }
    const before = store.length
    store = store.filter((s) => s.name !== name)
    if (store.length === before) return { ok: false, reason: '未找到' }
    writeFileSync(storePath, JSON.stringify(store, null, 2))
    return { ok: true }
  })

  ipcMain.handle('mount-member-mcp', (_event, memberName: string, mcpName: string) => {
    const { mkdirSync, writeFileSync } = require('fs')
    const memberDir = join(MEMBERS_DIR, memberName)
    const mcpsPath = join(memberDir, 'mcps.json')
    if (!existsSync(memberDir)) return { ok: false, reason: '成员不存在' }
    // 从商店读 MCP 信息
    const storePath = join(SHARED_DIR, 'mcp_store.json')
    let storeItems: StoreMcpItem[] = []
    if (existsSync(storePath)) {
      try { storeItems = JSON.parse(readFileSync(storePath, 'utf-8')) } catch { /* ignore */ }
    }
    const storeItem = storeItems.find((s) => s.name === mcpName)
    if (!storeItem) return { ok: false, reason: '商店中不存在该 MCP' }
    // 读成员已挂载
    let memberMcps: StoreMcpItem[] = []
    if (existsSync(mcpsPath)) {
      try { memberMcps = JSON.parse(readFileSync(mcpsPath, 'utf-8')) } catch { /* ignore */ }
    }
    if (memberMcps.some((m) => m.name === mcpName)) return { ok: false, reason: '已挂载' }
    memberMcps.push(storeItem)
    writeFileSync(mcpsPath, JSON.stringify(memberMcps, null, 2))
    return { ok: true }
  })

  ipcMain.handle('unmount-member-mcp', (_event, memberName: string, mcpName: string) => {
    const { writeFileSync } = require('fs')
    const mcpsPath = join(MEMBERS_DIR, memberName, 'mcps.json')
    if (!existsSync(mcpsPath)) return { ok: false, reason: '无挂载' }
    let memberMcps: StoreMcpItem[] = []
    try { memberMcps = JSON.parse(readFileSync(mcpsPath, 'utf-8')) } catch { return { ok: false, reason: '读取失败' } }
    const before = memberMcps.length
    memberMcps = memberMcps.filter((m) => m.name !== mcpName)
    if (memberMcps.length === before) return { ok: false, reason: '未挂载该 MCP' }
    writeFileSync(mcpsPath, JSON.stringify(memberMcps, null, 2))
    return { ok: true }
  })

  ipcMain.handle('get-member-mcps', (_event, memberName: string) => {
    const mcpsPath = join(MEMBERS_DIR, memberName, 'mcps.json')
    if (!existsSync(mcpsPath)) return []
    try { return JSON.parse(readFileSync(mcpsPath, 'utf-8')) as StoreMcpItem[] } catch { return [] }
  })

  // ── 项目 IPC ──
  ipcMain.handle('list-projects', () => listProjects())
  ipcMain.handle('get-project', (_event, id: string) => getProject(id))
  ipcMain.handle('create-project', (_event, data: Omit<ProjectData, 'id' | 'created_at' | 'updated_at'>) => createProject(data))
  ipcMain.handle('update-project', (_event, id: string, patch: Partial<Omit<ProjectData, 'id' | 'created_at'>>) => updateProject(id, patch))
  ipcMain.handle('delete-project', (_event, id: string) => deleteProject(id))
  ipcMain.handle('get-member-projects', (_event, memberName: string) => getMemberProjects(memberName))

  // ── PTY IPC ──
  ipcMain.handle('spawn-pty-session', (_event, opts: SpawnOptions) => {
    return spawnPtySession(opts)
  })

  ipcMain.handle('write-to-pty', (_event, sessionId: string, data: string) => {
    return writeToPty(sessionId, data)
  })

  ipcMain.handle('resize-pty', (_event, sessionId: string, cols: number, rows: number) => {
    return resizePty(sessionId, cols, rows)
  })

  ipcMain.handle('kill-pty-session', (_event, sessionId: string) => {
    return killPtySession(sessionId)
  })

  ipcMain.handle('get-pty-sessions', () => {
    return getPtySessions()
  })

  ipcMain.handle('get-pty-session', (_event, sessionId: string) => {
    return getPtySession(sessionId)
  })

  ipcMain.handle('get-pty-buffer', (_event, sessionId: string) => {
    return getPtyBuffer(sessionId)
  })

  ipcMain.handle('attach-pty-window', (event, sessionId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, reason: 'no window' }
    return attachWindow(sessionId, win)
  })

  ipcMain.handle('scan-agent-clis', (_event, force?: boolean) => {
    return scanAgentClis(force)
  })

  ipcMain.handle('select-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      properties: ['openDirectory'],
      title: '选择工作目录',
      buttonLabel: '选择'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('launch-member', (_event, opts: {
    memberName: string
    cliBin: string
    cliName: string
    isLeader?: boolean
    workspacePath?: string
  }) => {
    return openTerminalWindow(opts)
  })

  ipcMain.handle('get-theme', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  // ── 消息路由 IPC ──
  messageRouter = setupMessageRouter()
  setMessageRouter(messageRouter)

  ipcMain.handle('send-message', (_event, from: string, to: string, content: string, priority?: string) => {
    if (!messageRouter) return { ok: false, reason: 'router not ready' }
    const result = messageRouter.sendMessage(from, to, content, priority)
    if (result.error) return { ok: false, reason: result.error }
    return { ok: true, id: result.id, delivered: result.delivered }
  })

  ipcMain.handle('get-inbox', (_event, memberId: string) => {
    if (!messageRouter) return []
    return messageRouter.getInbox(memberId)
  })

  ipcMain.handle('clear-inbox', (_event, memberId: string) => {
    if (!messageRouter) return
    messageRouter.clearInbox(memberId)
  })

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme-change', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    }
  })
}

// ── 确保 Hub 服务运行 ────────────────────────────────────────────────────────
// Panel 依赖 Hub HTTP 服务（127.0.0.1:58578）提供团队数据。
// MCP server 也通过 Hub 代理读写成员状态，如果 Hub 没启动，MCP 工具会全部失败。
// 因此 Panel 启动时主动拉起 Hub，保证整个系统可用。
async function ensureHub(): Promise<void> {
  const HUB_DIR = join(homedir(), '.claude', 'team-hub')
  const pidFile = join(HUB_DIR, 'hub.pid')
  const portFile = join(HUB_DIR, 'hub.port')
  const defaultPort = 58578

  function getPort(): number {
    try {
      const p = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
      return isNaN(p) ? defaultPort : p
    } catch { return defaultPort }
  }

  async function isHealthy(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch { return false }
  }

  const port = getPort()
  if (await isHealthy(port)) {
    console.log(`[panel] Hub already running on port ${port}`)
    return
  }

  // Hub 没在跑，启动它
  // hub.ts 路径：相对于 panel/out/main/index.js → ../../mcp-server/src/hub.ts
  const hubScript = join(__dirname, '../../../mcp-server/src/hub.ts')

  if (!existsSync(hubScript)) {
    console.warn(`[panel] Hub script not found: ${hubScript}`)
    return
  }

  let bunBin = 'bun'
  try { bunBin = execSync('which bun', { encoding: 'utf-8', timeout: 3000 }).trim() || bunBin } catch {}

  mkdirSync(HUB_DIR, { recursive: true })
  const logFile = join(HUB_DIR, 'hub.log')
  const logFd = openSync(logFile, 'a')

  const child = spawn(bunBin, ['run', hubScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: dirname(hubScript),
  })
  child.unref()
  closeSync(logFd)

  // 等待 Hub 就绪（最多 5 秒，每 200ms 轮询）
  let ready = false
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (await isHealthy(getPort())) { ready = true; break }
  }

  if (ready) {
    console.log(`[panel] Hub started successfully`)
  } else {
    console.warn(`[panel] Hub startup timeout, check ${logFile}`)
  }
}

// ── App 生命周期 ──────────────────────────────────────────────────────────────
app.name = 'MCP-Team-Hub'
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 先确保 Hub 服务在跑，MCP server 和 Panel 都依赖它
    await ensureHub()

    // ⚠️ 启动清理：kill -9 / crash / 断电等异常退出不会触发 win.on('closed')，
    // 所以这里是最后防线。必须覆盖：
    // 1. lock.json 对应的 session_pid 不存在或 lstart 不匹配
    // 2. heartbeat.json 对应的 session_pid 不存在（含无 lock 的孤儿心跳）
    // 3. heartbeat.json 超时未更新（> 3 分钟）
    try {
      const STALE_HEARTBEAT_MS = 3 * 60 * 1000
      const memberDirs = readdirSync(MEMBERS_DIR).filter((d) => {
        try { return statSync(join(MEMBERS_DIR, d)).isDirectory() } catch { return false }
      })
      for (const dir of memberDirs) {
        let cleaned = false

        // 检查 lock.json
        const lockPath = join(MEMBERS_DIR, dir, 'lock.json')
        if (existsSync(lockPath)) {
          try {
            const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockFile
            // 注意：字段名是 session_pid 不是 pid
            const pid = lock.session_pid
            if (pid) {
              // 用 isPidAlive + lstart 双重校验，防止 PID 复用误判
              const alive = isPidAlive(pid) && getPidLstart(pid) === lock.session_start
              if (!alive) {
                rmSync(lockPath, { force: true })
                cleaned = true
              }
            } else {
              // lock 格式异常，直接删
              rmSync(lockPath, { force: true })
              cleaned = true
            }
          } catch {
            rmSync(lockPath, { force: true })
            cleaned = true
          }
        }

        // 检查 heartbeat.json（独立于 lock 检查，覆盖孤儿心跳场景）
        const hbPath = join(MEMBERS_DIR, dir, 'heartbeat.json')
        if (existsSync(hbPath)) {
          try {
            const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as HeartbeatFile
            const pid = hb.session_pid
            const pidDead = pid ? !isPidAlive(pid) : true
            const timedOut = hb.last_seen_ms ? (Date.now() - hb.last_seen_ms > STALE_HEARTBEAT_MS) : true
            if (pidDead || timedOut) {
              rmSync(hbPath, { force: true })
              cleaned = true
            }
          } catch {
            rmSync(hbPath, { force: true })
            cleaned = true
          }
        }

        if (cleaned) {
          // 也清掉可能残留的 reservation
          const resPath = join(MEMBERS_DIR, dir, 'reservation.json')
          try { rmSync(resPath, { force: true }) } catch {}
        }
      }
    } catch {}

    setupIpc()
    setupTerminalIpc()
    startPanelApi()
    createWindow()
    createOverlay()
    startWatcher()
    startPoll()
    setupPowerMonitor()
  })

  app.on('window-all-closed', () => {
    stopWatcher()
    stopPoll()
    app.quit() // 关窗口即退出，不保留 dock
  })

  app.on('before-quit', () => {
    // 清理所有成员的 lock 和 heartbeat 文件
    try {
      const memberDirs = readdirSync(MEMBERS_DIR).filter((d) => {
        try { return statSync(join(MEMBERS_DIR, d)).isDirectory() } catch { return false }
      })
      for (const dir of memberDirs) {
        const lockPath = join(MEMBERS_DIR, dir, 'lock.json')
        const hbPath = join(MEMBERS_DIR, dir, 'heartbeat.json')
        try { rmSync(lockPath, { force: true }) } catch {}
        try { rmSync(hbPath, { force: true }) } catch {}
      }
    } catch {}
    // Cleanup message router
    teardownMessageRouter()
    // Stop Panel HTTP API and remove panel.port file
    stopPanelApi()
    // Kill all running PTY sessions
    killAllPtySessions()
    // Panel 退出时杀掉 Hub 进程
    const pidFile = join(TEAM_HUB_DIR, 'hub.pid')
    const portFile = join(TEAM_HUB_DIR, 'hub.port')
    const panelPidFile = join(TEAM_HUB_DIR, 'panel.pid')
    try {
      const hubPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      if (!isNaN(hubPid)) process.kill(hubPid, 'SIGTERM')
    } catch { /* hub 可能已停 */ }
    try { rmSync(pidFile, { force: true }) } catch {}
    try { rmSync(portFile, { force: true }) } catch {}
    try { rmSync(panelPidFile, { force: true }) } catch {}
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}
