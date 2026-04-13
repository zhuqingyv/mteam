import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell
} from 'electron'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { execSync } from 'child_process'
import chokidar, { FSWatcher } from 'chokidar'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const TEAM_HUB_DIR = resolve(homedir(), '.claude/team-hub')
const SESSIONS_DIR = join(TEAM_HUB_DIR, 'sessions')
const MEMBERS_DIR = join(TEAM_HUB_DIR, 'members')

// ── 类型 ──────────────────────────────────────────────────────────────────────
interface SessionFile {
  pid: number
  lstart: string
  cwd: string
  started_at: string
}

interface LockFile {
  nonce: string
  session_pid: number
  session_start: string
  project: string
  task: string
  locked_at: string
}

interface ProfileFile {
  name: string
  call_name: string
  role: string
  type: 'permanent' | 'temporary'
  created_at: string
}

export interface MemberStatus {
  name: string
  callName: string
  role: string
  type: 'permanent' | 'temporary'
  busy: boolean
  project?: string
  task?: string
  lockedAt?: string
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
  } catch {
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

// ── 数据扫描 ──────────────────────────────────────────────────────────────────
function scanTeamStatus(): TeamStatus {
  const scannedAt = new Date().toISOString()
  let errorMsg: string | undefined

  // 确保目录存在
  for (const dir of [TEAM_HUB_DIR, SESSIONS_DIR, MEMBERS_DIR]) {
    if (!existsSync(dir)) {
      return {
        sessions: [],
        members: [],
        scannedAt,
        healthy: true
      }
    }
  }

  // 扫描 sessions
  let sessionFiles: SessionFile[] = []
  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    sessionFiles = files
      .map((f) => readJson<SessionFile>(join(SESSIONS_DIR, f)))
      .filter((s): s is SessionFile => s !== null)
  } catch (e) {
    errorMsg = String(e)
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

      const profile = readJson<ProfileFile>(profilePath)
      if (!profile) continue

      const lock = readJson<LockFile>(lockPath)

      members.push({
        name: profile.name,
        callName: profile.call_name,
        role: profile.role,
        type: profile.type,
        busy: lock !== null,
        project: lock?.project,
        task: lock?.task,
        lockedAt: lock?.locked_at
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
  if (!existsSync(SESSIONS_DIR)) return

  let files: string[]
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }

  for (const file of files) {
    const sessionPath = join(SESSIONS_DIR, file)
    const session = readJson<SessionFile>(sessionPath)
    if (!session) continue

    const alive = isPidAlive(session.pid)
    if (alive) continue

    // 进程不存在，用 lstart 双验
    const lstart = getPidLstart(session.pid)
    if (lstart && lstart === session.lstart) {
      // 进程还活着（不太可能，但保险）
      continue
    }

    // 确认死亡，清理 session 文件
    try {
      rmSync(sessionPath)
    } catch {
      // ignore
    }

    // 清理该 session 持有的所有锁（nonce 双验）
    if (!existsSync(MEMBERS_DIR)) continue
    let memberDirs: string[]
    try {
      memberDirs = readdirSync(MEMBERS_DIR)
    } catch {
      continue
    }

    for (const memberDir of memberDirs) {
      const lockPath = join(MEMBERS_DIR, memberDir, 'lock.json')
      if (!existsSync(lockPath)) continue

      const lock = readJson<LockFile>(lockPath)
      if (!lock || lock.session_pid !== session.pid) continue

      // 记住 nonce，再读一次确认
      const nonce = lock.nonce
      const lockAgain = readJson<LockFile>(lockPath)
      if (!lockAgain || lockAgain.nonce !== nonce) continue

      try {
        rmSync(lockPath)
      } catch {
        // ignore
      }
    }
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
function startWatcher(): void {
  if (watcher) return
  if (!existsSync(TEAM_HUB_DIR)) return

  watcher = chokidar.watch(TEAM_HUB_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3
  })

  watcher.on('all', () => {
    pushStatus()
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

// ── IPC ───────────────────────────────────────────────────────────────────────
function setupIpc(): void {
  ipcMain.handle('get-initial-status', () => {
    return scanTeamStatus()
  })

  ipcMain.handle('get-theme', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme-change', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    }
  })
}

// ── App 生命周期 ──────────────────────────────────────────────────────────────
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

  app.whenReady().then(() => {
    setupIpc()
    createWindow()
    startWatcher()
    startPoll()
    setupPowerMonitor()
  })

  app.on('window-all-closed', () => {
    stopWatcher()
    stopPoll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}
