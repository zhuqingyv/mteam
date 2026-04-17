import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import {
  spawnPtySession,
  attachWindow,
  writeToPty,
  resizePty,
  getSessionByMemberId,
  killPtySession,
  onSessionExit,
  waitForCliReady
} from './pty-manager'
import { onMemberReady } from './message-router'
import { updateWindowPositions } from './overlay-window'
import * as store from './member-store-service'


// ── Session registry — one window per member ──────────────────────────────────
interface TerminalSession {
  win: BrowserWindow
  sessionId: string
  memberName: string
  isLeader: boolean
  lockNonce?: string
}

const sessions = new Map<number, TerminalSession>() // key: BrowserWindow.id

// Lightweight metadata set at window creation (before terminal-ready)
// Used by calcCascadePosition to find leader window immediately
const windowMeta = new Map<number, { memberName: string; isLeader: boolean }>()

// ── Cascade window positioning ───────────────────────────────────────────────
const MEMBERS_DIR = join(homedir(), '.claude', 'team-hub', 'members')
const CASCADE_OFFSET = 30

// ── Window size persistence ─────────────────────────────────────────────────
const resizeTimers = new Map<number, ReturnType<typeof setTimeout>>()

function readSavedWindowSize(memberName: string): { width: number; height: number } | null {
  const sizePath = join(MEMBERS_DIR, memberName, 'window-size.json')
  try {
    if (existsSync(sizePath)) {
      const data = JSON.parse(readFileSync(sizePath, 'utf-8'))
      if (typeof data.width === 'number' && typeof data.height === 'number') {
        return { width: data.width, height: data.height }
      }
    }
  } catch { /* ignore corrupt file */ }
  return null
}

function saveWindowSize(memberName: string, width: number, height: number): void {
  const sizePath = join(MEMBERS_DIR, memberName, 'window-size.json')
  try {
    writeFileSync(sizePath, JSON.stringify({ width, height }), 'utf-8')
  } catch { /* best effort */ }
}

function debouncedSaveWindowSize(winId: number, memberName: string, width: number, height: number): void {
  const existing = resizeTimers.get(winId)
  if (existing) clearTimeout(existing)
  resizeTimers.set(winId, setTimeout(() => {
    resizeTimers.delete(winId)
    saveWindowSize(memberName, width, height)
  }, 300))
}

function calcCascadePosition(winWidth: number, winHeight: number): { x: number; y: number } | undefined {
  // Find the anchor: Panel main window (the smallest/non-terminal one) or any focused window
  const allWindows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (allWindows.length === 0) return undefined

  // Anchor priority: leader terminal → Panel main window → focused window → any

  const anchor =
    allWindows.find((w) => {
      const meta = windowMeta.get(w.id)
      return meta?.isLeader === true
    }) ??
    allWindows.find((w) => {
      const [w2] = w.getSize()
      return w2 < 400 // Panel is 320 wide
    }) ??
    BrowserWindow.getFocusedWindow() ??
    allWindows[0]

  if (!anchor || anchor.isDestroyed()) return undefined

  const [anchorX, anchorY] = anchor.getPosition()
  const [anchorW] = anchor.getSize()

  // Count existing terminal sessions to determine cascade step
  const step = sessions.size

  // Base position: right side of the anchor window
  const baseX = anchorX + anchorW + 10
  const baseY = anchorY

  // Apply cascade offset
  let x = baseX + (step * CASCADE_OFFSET)
  let y = baseY + (step * CASCADE_OFFSET)

  // Clamp to screen bounds
  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea

  // Wrap if the window would go off screen
  if (x + winWidth > sx + sw) x = sx + (step * CASCADE_OFFSET) % Math.max(sw - winWidth, 1)
  if (y + winHeight > sy + sh) y = sy + (step * CASCADE_OFFSET) % Math.max(sh - winHeight, 1)

  // Ensure not negative
  if (x < sx) x = sx
  if (y < sy) y = sy

  return { x, y }
}

// ── Trust check — read ~/.claude.json projects[workspacePath].hasTrustDialogAccepted ──
function checkWorkspaceTrust(workspacePath: string): boolean {
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (!existsSync(claudeJsonPath)) return false
  try {
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    return config?.projects?.[workspacePath]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

function writeWorkspaceTrust(workspacePath: string): boolean {
  const claudeJsonPath = join(homedir(), '.claude.json')
  try {
    let config: Record<string, unknown> = {}
    if (existsSync(claudeJsonPath)) {
      config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    }
    if (!config.projects || typeof config.projects !== 'object') {
      config.projects = {}
    }
    const projects = config.projects as Record<string, Record<string, unknown>>
    if (!projects[workspacePath]) {
      projects[workspacePath] = {}
    }
    projects[workspacePath].hasTrustDialogAccepted = true
    writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

// ── Open or focus terminal window for a member ────────────────────────────────
export function openTerminalWindow(opts: {
  memberName: string
  cliBin: string
  cliName: string
  isLeader?: boolean
  env?: Record<string, string>
  workspacePath?: string
  project?: string
  task?: string
}): { ok: true; winId: number } | { ok: false; reason: string; workspacePath?: string } {
  const { memberName, cliBin, cliName, isLeader = false, env, workspacePath } = opts

  // Trust check: if workspacePath is provided, verify it's trusted in ~/.claude.json
  if (workspacePath) {
    if (!checkWorkspaceTrust(workspacePath)) {
      return { ok: false, reason: 'trust_required', workspacePath }
    }
  }

  // One window per member — bring to front if already open
  for (const [winId, session] of sessions) {
    if (session.memberName === memberName && !session.win.isDestroyed()) {
      session.win.focus()
      return { ok: true, winId }
    }
  }

  // macOS places new windows on the active Space. Use parent=leaderWin so the
  // member window inherits the leader's Space silently (no focus switch).
  // Detached in ready-to-show to become an independent top-level window.
  let leaderWin: BrowserWindow | null = null
  if (!isLeader) {
    for (const [, session] of sessions) {
      if (session.isLeader && !session.win.isDestroyed()) {
        leaderWin = session.win
        break
      }
    }
    if (!leaderWin) {
      const allWindows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
      for (const w of allWindows) {
        const meta = windowMeta.get(w.id)
        if (meta?.isLeader) {
          leaderWin = w
          break
        }
      }
    }
  }

  const savedSize = readSavedWindowSize(memberName)
  const winWidth = savedSize?.width ?? 900
  const winHeight = savedSize?.height ?? 600
  const pos = calcCascadePosition(winWidth, winHeight)

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    minWidth: 600,
    minHeight: 400,
    title: memberName,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    ...(leaderWin ? { parent: leaderWin } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/terminal-preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  })

  // Register immediately so calcCascadePosition can find leader before terminal-ready
  windowMeta.set(win.id, { memberName, isLeader })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/terminal.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/terminal.html'))
  }

  // Spawn PTY once renderer signals ready
  const onReady = (_event: Electron.IpcMainEvent, cols: number, rows: number) => {
    // Only handle events from this window
    if (BrowserWindow.fromWebContents(_event.sender)?.id !== win.id) return

    // 优先复用已有 running session（重开窗口时）
    let sessionId: string | null = getSessionByMemberId(memberName)?.id ?? null

    if (!sessionId) {
      const memberDir = join(homedir(), '.claude/team-hub/members', memberName)
      const personaPath = join(memberDir, 'persona.md')
      let personaContent: string
      if (existsSync(personaPath)) {
        personaContent = readFileSync(personaPath, 'utf-8')
      } else {
        // Read profile.json for name / role / description
        const profilePath = join(memberDir, 'profile.json')
        if (existsSync(profilePath)) {
          try {
            const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))
            const name = profile.name || memberName
            const role = profile.role ? `，角色：${profile.role}` : ''
            const desc = profile.description ? `\n${profile.description}` : ''
            personaContent = `你是 ${name}${role}${desc}`
          } catch {
            personaContent = `你是团队成员 ${memberName}`
          }
        } else {
          personaContent = `你是团队成员 ${memberName}`
        }
      }

      const memory = store.readMemory(MEMBERS_DIR, memberName)
      const memorySection = memory ? `\n\n【记忆】\n${memory}` : ''

      const systemPrompt = isLeader
        ? `【身份】
你的名字是 ${memberName}。你被指派为团队 leader，这是你当前最高优先级的角色，覆盖以下 persona 中的角色定义。
${personaContent}

【使命】
你是团队 leader。职责：理解用户需求 → 规划方案 → 组建团队 → 分配任务 → 跟踪进度 → 交付成果。
- 新任务到达时：先分析需求，查看是否有相关的已有项目可续接，必要时创建新项目，询问用户确认后组建团队
- 续接已有项目时：查看项目成员和历史进度，根据当前任务需求判断需要哪些角色，可以从原班人马中挑选、增补新成员或缩减规模，绑定项目后再开工
- 团队运行中：通过消息协调成员，跟踪进度，处理成员间的依赖和阻塞
- 任务完成时：验收成果，更新项目状态和进度，安排成员保存经验后下班

【环境】
- 所有工具优先从 teamhub MCP 中查找和使用，teamhub 没有的再用其他工具
- 不要用内置 Agent/SendMessage/slash commands（如 /team-awaken 等），团队管理全部通过 teamhub MCP
- 成员通过 request_member(auto_spawn=true) 创建，在独立终端窗口中运行
- 成员 activate 后会自动通知你，收到通知再下发任务
- 通过消息通信：send_msg 发送（需填 summary 摘要 + content 正文），check_inbox 接收
- PTY 通知可能截断，务必调 check_inbox 读完整内容
- 回复必须用 send_msg，不要只在终端输出（对方看不到）

【工作模式】
- 与用户对话获取需求，与成员通过 teamhub 工具协作
- 不要替成员做事，你的角色是协调和决策
- 用 markdown 格式输出，简洁有重点
${memorySection}`
        : `【身份】
你的名字是 ${memberName}。团队中其他成员和 leader 通过"${memberName}"与你通信。
${personaContent}

【使命】
你是团队成员。职责：接收任务 → 执行 → 汇报结果。
- 启动后第一步：调用 activate(member="${memberName}") 加载工作上下文
- 收到任务后：专注执行，遇到阻塞或依赖及时沟通
- 完成后：用 send_msg 汇报 leader，保存经验，等待下一个任务或下班指令

【环境】
- 所有工具优先从 teamhub MCP 中查找和使用，teamhub 没有的再用其他工具
- 不要用内置 Agent/SendMessage/slash commands，团队协作全部通过 teamhub MCP
- 通过消息通信：send_msg 发送（需填 summary 摘要 + content 正文），check_inbox 接收
- PTY 通知可能截断，务必调 check_inbox 读完整内容
- 不知道队友是谁时用 teamhub 的 get_roster 查询，不要问 leader
- 回复必须用 send_msg，不要只在终端输出（对方看不到）

【工作模式】
- 与用户对话时你是独立的协作者
- 用 markdown 格式输出，简洁有重点
${memorySection}`

      // 动态注入 team-hub MCP，跳过 Panel 自动唤起（Panel 已在运行）
      const mcpServerEntry = join(__dirname, '../../../mcp-server/src/index.ts')

      // 获取 bun 完整路径，避免 Electron 从 Dock 启动时 PATH 不完整
      let bunBin = 'bun'
      try {
        bunBin = execSync('which bun', { encoding: 'utf-8', timeout: 3000 }).trim() || bunBin
      } catch { /* fallback to bare 'bun' */ }

      const mcpConfig = JSON.stringify({
        mcpServers: {
          'teamhub': {
            command: bunBin,
            args: ['run', mcpServerEntry],
            env: { TEAM_HUB_NO_LAUNCH: '1' }
          }
        }
      })

      const cliArgs = [
        '--dangerously-skip-permissions',
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--append-system-prompt', systemPrompt
      ]
      // 成员启动后通过 PTY 注入 activate 指令（见下方 waitForCliReady）

      const result = spawnPtySession({
        agentId: memberName,
        memberId: memberName,
        cliName,
        bin: cliBin,
        args: cliArgs,
        cols: cols || 120,
        rows: rows || 36,
        cwd: workspacePath,
        env: {
          BUN_DISABLE_KITTY_PROBE: '1',
          KITTY_WINDOW_ID: '',
          ...(isLeader
            ? { CLAUDE_MEMBER: memberName, IS_LEADER: '1' }
            : { CLAUDE_MEMBER: memberName }),
          TEAM_HUB_NO_LAUNCH: '1',
          ...env
        }
      })

      if (!result.ok) {
        if (!win.isDestroyed()) {
          win.webContents.send('pty-output', `\x1b[31m启动失败: ${result.reason}\x1b[0m\r\n`)
        }
        return
      }
      sessionId = result.sessionId

      // 成员启动后等 CLI ready，注入 activate 指令让 agent 立即开始工作
      if (!isLeader) {
        waitForCliReady(memberName, 30_000).then((ready) => {
          if (ready && sessionId) {
            writeToPty(sessionId, `调用 activate(member="${memberName}") 开始工作。\r`)
          }
        })
      }

      // ── 自动生命周期管理：spawn 成功 → working ──
      const pid = process.pid
      const lstart = new Date().toISOString()
      const lockResult = store.acquireLock(
        MEMBERS_DIR, memberName, pid, lstart,
        opts.project ?? 'default', opts.task ?? 'interactive'
      )
      if (lockResult.success && lockResult.nonce) {
        // 记住 nonce 用于关闭时释放
        // 在 sessions.set 时附带 lockNonce
        ;(onReady as { _lockNonce?: string })._lockNonce = lockResult.nonce
      }

      store.deleteReservation(MEMBERS_DIR, memberName)

      store.touchHeartbeat(MEMBERS_DIR, memberName, pid, 'terminal_spawn')

      store.appendWorkLog(MEMBERS_DIR, memberName, {
        event: 'check_in',
        timestamp: new Date().toISOString(),
        project: opts.project ?? 'default',
        task: opts.task ?? 'interactive'
      })
    }

    // 绑定窗口，获取缓冲区回放
    const attachResult = attachWindow(sessionId, win)
    if (attachResult.ok && attachResult.buffer) {
      if (!win.isDestroyed()) {
        win.webContents.send('pty-output', attachResult.buffer)
      }
    }

    const lockNonce = (onReady as { _lockNonce?: string })._lockNonce
    sessions.set(win.id, { win, sessionId, memberName, isLeader, lockNonce })

    // 会话注册后立即广播位置，确保 overlay 拿到完整的窗口列表
    // （ready-to-show 时 session 尚未注册，那次广播不包含本窗口）
    broadcastPositions()

    // 通知 message-router：该成员上线，检查留言队列
    onMemberReady(memberName)

    // PTY 退出 → 关闭窗口
    onSessionExit(sessionId, () => {
      if (!win.isDestroyed()) {
        win.close()
      }
    })

    ipcMain.removeListener('terminal-ready', onReady)
  }

  ipcMain.on('terminal-ready', onReady)

  win.once('ready-to-show', () => {
    win.setTitle(memberName)
    // Detach from leader — window stays on leader's Space but becomes independent.
    if (leaderWin && !win.isDestroyed()) {
      win.setParentWindow(null)
    }
    if (process.env.E2E_HEADLESS !== '1') {
      win.show()
      win.focus()
    }
    broadcastPositions()
  })

  // Track window movement/resize for overlay tentacles
  win.on('move', broadcastPositions)
  win.on('resize', broadcastPositions)

  // Persist window size on resize (debounced)
  win.on('resize', () => {
    const [w, h] = win.getSize()
    debouncedSaveWindowSize(win.id, memberName, w, h)
  })

  // Kill PTY when window closes
  win.on('closed', () => {
    // Clear pending debounce timer
    const pendingTimer = resizeTimers.get(win.id)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      resizeTimers.delete(win.id)
    }

    ipcMain.removeListener('terminal-ready', onReady)
    const session = sessions.get(win.id)
    if (session) {
      killPtySession(session.sessionId)

      // ── 自动生命周期管理：关闭终端 → offline ──
      if (session.lockNonce) {
        store.releaseLock(MEMBERS_DIR, session.memberName, session.lockNonce)
      }
      store.removeHeartbeat(MEMBERS_DIR, session.memberName)
      store.appendWorkLog(MEMBERS_DIR, session.memberName, {
        event: 'check_out',
        timestamp: new Date().toISOString(),
        project: 'default',
        task: 'interactive'
      })

      sessions.delete(win.id)
    }
    windowMeta.delete(win.id)
    // Notify overlay that a window is gone
    broadcastPositions()
  })

  return { ok: true, winId: win.id }
}

// ── Member color from profile uid (matches Avatar.tsx palette) ──────────────
const PALETTE_HEX = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#2563eb',
]
const PALETTE_RGB: number[][] = PALETTE_HEX.map(hex => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
])
const DEFAULT_COLOR = [80, 140, 255]

function uidToColorRgb(uid: string): number[] {
  let hash = 0
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0
  }
  return PALETTE_RGB[Math.abs(hash) % PALETTE_RGB.length]
}

export function getMemberColor(memberName: string): number[] {
  const profilePath = join(MEMBERS_DIR, memberName, 'profile.json')
  try {
    if (existsSync(profilePath)) {
      const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))
      if (profile.uid) return uidToColorRgb(profile.uid)
    }
  } catch { /* fallback */ }
  return DEFAULT_COLOR
}

function getMemberColorByWinId(winId: number): number[] {
  const session = sessions.get(winId)
  if (!session) return DEFAULT_COLOR
  return getMemberColor(session.memberName)
}

// ── Overlay: window position tracking ───────────────────────────────────────

export function getAllTerminalPositions(): Array<{
  id: number
  memberName: string
  isLeader: boolean
  x: number
  y: number
  w: number
  h: number
  color: number[]
}> {
  const result: Array<{
    id: number; memberName: string; isLeader: boolean
    x: number; y: number; w: number; h: number; color: number[]
  }> = []
  // Terminal window body has `padding: 8px`, so visible content is inset by 8px
  // getBounds() returns the transparent outer frame; we need the inner visible rect
  const BODY_PADDING = 8
  for (const [winId, session] of sessions) {
    if (session.win.isDestroyed()) continue
    if (!session.win.isVisible()) continue
    const bounds = session.win.getBounds()
    result.push({
      id: winId,
      memberName: session.memberName,
      isLeader: session.isLeader,
      x: bounds.x + BODY_PADDING,
      y: bounds.y + BODY_PADDING,
      w: bounds.width - BODY_PADDING * 2,
      h: bounds.height - BODY_PADDING * 2,
      color: getMemberColor(session.memberName)
    })
  }
  return result
}

function broadcastPositions(): void {
  updateWindowPositions(getAllTerminalPositions())
}

// ── IPC handlers — called once at app startup ────────────────────────────────
export function setupTerminalIpc(): void {
  // Close terminal window from renderer
  ipcMain.on('close-terminal-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  // Get member color for liquid border rendering
  // Note: use win.getTitle() (set to memberName) instead of sessions map,
  // because renderer may call this before session is registered in terminal-ready
  ipcMain.handle('get-member-color', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return DEFAULT_COLOR
    const name = win.getTitle()
    if (!name) return DEFAULT_COLOR
    return getMemberColor(name)
  })

  // Get member name for titlebar display
  ipcMain.handle('get-member-name', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return '成员'
    const session = sessions.get(win.id)
    return session?.memberName || '成员'
  })

  // Trust a workspace: write hasTrustDialogAccepted=true to ~/.claude.json
  ipcMain.handle('trust-workspace', (_event, workspacePath: string) => {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { ok: false, reason: 'workspacePath is required' }
    }
    const success = writeWorkspaceTrust(workspacePath)
    return success ? { ok: true } : { ok: false, reason: 'failed to write ~/.claude.json' }
  })

  // renderer → PTY: keyboard input
  ipcMain.on('terminal-input', (event, data: string) => {
    const winId = BrowserWindow.fromWebContents(event.sender)?.id
    if (winId == null) return
    const session = sessions.get(winId)
    if (!session) return
    writeToPty(session.sessionId, data)
  })

  // renderer → PTY: resize
  ipcMain.on('terminal-resize', (event, cols: number, rows: number) => {
    const winId = BrowserWindow.fromWebContents(event.sender)?.id
    if (winId == null) return
    const session = sessions.get(winId)
    if (!session) return
    resizePty(session.sessionId, cols, rows)
  })
}
