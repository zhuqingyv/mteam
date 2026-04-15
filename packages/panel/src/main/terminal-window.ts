import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, writeFileSync } from 'fs'
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


// ── Session registry — one window per member ──────────────────────────────────
interface TerminalSession {
  win: BrowserWindow
  sessionId: string
  memberName: string
}

const sessions = new Map<number, TerminalSession>() // key: BrowserWindow.id

// ── Cascade window positioning ───────────────────────────────────────────────
const CASCADE_OFFSET = 30

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
  displayName: string
  cliBin: string
  cliName: string
  isLeader?: boolean
  env?: Record<string, string>
  workspacePath?: string
}): { ok: true; winId: number } | { ok: false; reason: string; workspacePath?: string } {
  const { memberName, displayName, cliBin, cliName, isLeader = false, env, workspacePath } = opts

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

  const winWidth = 900
  const winHeight = 600
  const pos = calcCascadePosition(winWidth, winHeight)

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    minWidth: 600,
    minHeight: 400,
    title: displayName,
    frame: true,
    backgroundColor: '#0d0d0d',
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
        // Read profile.json for display_name / role / description
        const profilePath = join(memberDir, 'profile.json')
        if (existsSync(profilePath)) {
          try {
            const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))
            const name = profile.display_name || memberName
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

      const systemPrompt = `【身份】
${personaContent}

${isLeader ? '你被指派为 leader。使用 team-hub MCP 的 request_member(auto_spawn=true) 为成员创建独立终端窗口，不要使用内置 Agent 工具。' : '你是团队成员，专注于自己的角色和任务。'}

这是独立交互式终端会话，与你对话的是用户本人。直接以上述身份与用户协作。`

      const result = spawnPtySession({
        agentId: memberName,
        memberId: memberName,
        cliName,
        bin: cliBin,
        args: ['--dangerously-skip-permissions', '--append-system-prompt', systemPrompt],
        cols: cols || 120,
        rows: rows || 36,
        cwd: workspacePath,
        env: {
          BUN_DISABLE_KITTY_PROBE: '1',
          KITTY_WINDOW_ID: '',
          CLAUDE_MEMBER: memberName,
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
    }

    // 绑定窗口，获取缓冲区回放
    const attachResult = attachWindow(sessionId, win)
    if (attachResult.ok && attachResult.buffer) {
      if (!win.isDestroyed()) {
        win.webContents.send('pty-output', attachResult.buffer)
      }
    }

    // Lock 由 MCP activate 流程管理，Panel 不再直接写 lock.json

    sessions.set(win.id, { win, sessionId, memberName })

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
    win.setTitle(displayName)
    win.show()
  })

  // Kill PTY when window closes
  win.on('closed', () => {
    ipcMain.removeListener('terminal-ready', onReady)
    const session = sessions.get(win.id)
    if (session) {
      killPtySession(session.sessionId)
      // Lock 由 MCP deactivate 流程管理，Panel 不再直接删 lock.json
      sessions.delete(win.id)
    }
  })

  return { ok: true, winId: win.id }
}

// ── IPC handlers — called once at app startup ────────────────────────────────
export function setupTerminalIpc(): void {
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
