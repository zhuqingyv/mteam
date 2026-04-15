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
  onSessionExit
} from './pty-manager'
import { onMemberReady } from './message-router'
import { updateWindowPositions } from './overlay-window'
import * as store from './member-store-service'


// ── Session registry — one window per member ──────────────────────────────────
interface TerminalSession {
  win: BrowserWindow
  sessionId: string
  memberName: string
  lockNonce?: string
}

const sessions = new Map<number, TerminalSession>() // key: BrowserWindow.id

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

  // The Panel main window is typically the smallest (320x520), pick it as anchor.
  // Fallback to focused window, then to the first window.
  const anchor =
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
    webPreferences: {
      preload: join(__dirname, '../preload/terminal-preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

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

      const systemPrompt = `【身份】
${personaContent}

${isLeader ? '你被指派为 leader。使用 teamhub MCP 的 request_member(auto_spawn=true) 为成员创建独立终端窗口，不要使用内置 Agent 工具。' : '你是团队成员，专注于自己的角色和任务。'}

定期调用 check_inbox 查看是否有新消息。

这是独立交互式终端会话，与你对话的是用户本人。直接以上述身份与用户协作。${memorySection}`

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

      const result = spawnPtySession({
        agentId: memberName,
        memberId: memberName,
        cliName,
        bin: cliBin,
        args: [
          '--dangerously-skip-permissions',
          '--mcp-config', mcpConfig,
          '--strict-mcp-config',
          '--append-system-prompt', systemPrompt
        ],
        cols: cols || 120,
        rows: rows || 36,
        cwd: workspacePath,
        env: {
          BUN_DISABLE_KITTY_PROBE: '1',
          KITTY_WINDOW_ID: '',
          CLAUDE_MEMBER: memberName,
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
    sessions.set(win.id, { win, sessionId, memberName, lockNonce })

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
    win.show()
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
    // Notify overlay that a window is gone
    broadcastPositions()
  })

  return { ok: true, winId: win.id }
}

// ── Member color mapping ─────────────────────────────────────────────────────
const MEMBER_COLORS: Record<string, number[]> = {
  '老锤': [30, 140, 255],
  '小快': [255, 60, 90],
  '阿构': [0, 200, 130],
  '刺猬': [255, 180, 30],
  '阿点': [180, 80, 255]
}
const DEFAULT_COLOR = [80, 140, 255]

function getMemberColorByWinId(winId: number): number[] {
  const session = sessions.get(winId)
  if (!session) return DEFAULT_COLOR
  return MEMBER_COLORS[session.memberName] ?? DEFAULT_COLOR
}

// ── Overlay: window position tracking ───────────────────────────────────────

export function getAllTerminalPositions(): Array<{
  id: number
  memberName: string
  x: number
  y: number
  w: number
  h: number
  color: number[]
}> {
  const result: Array<{
    id: number; memberName: string
    x: number; y: number; w: number; h: number; color: number[]
  }> = []
  // Terminal window body has `padding: 8px`, so visible content is inset by 8px
  // getBounds() returns the transparent outer frame; we need the inner visible rect
  const BODY_PADDING = 8
  for (const [winId, session] of sessions) {
    if (session.win.isDestroyed()) continue
    const bounds = session.win.getBounds()
    result.push({
      id: winId,
      memberName: session.memberName,
      x: bounds.x + BODY_PADDING,
      y: bounds.y + BODY_PADDING,
      w: bounds.width - BODY_PADDING * 2,
      h: bounds.height - BODY_PADDING * 2,
      color: MEMBER_COLORS[session.memberName] ?? DEFAULT_COLOR
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
  ipcMain.handle('get-member-color', (event) => {
    const winId = BrowserWindow.fromWebContents(event.sender)?.id
    if (winId == null) return DEFAULT_COLOR
    return getMemberColorByWinId(winId)
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
