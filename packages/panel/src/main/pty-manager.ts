import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PtyStatus = 'spawning' | 'running' | 'exited' | 'killed'

export interface PtySession {
  id: string
  agentId: string
  memberId: string
  cliName: string
  bin: string
  status: PtyStatus
  cols: number
  rows: number
  startedAt: string
  exitCode?: number
  /** Working directory the PTY was spawned with */
  cwd?: string
}

export interface SpawnOptions {
  agentId: string
  memberId: string
  cliName: string
  bin: string
  args?: string[]
  cols?: number
  rows?: number
  /** Working directory for the PTY process */
  cwd?: string
  /** Extra env vars merged over process.env */
  env?: Record<string, string>
}

export type SpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string }

// ── Ring Buffer ───────────────────────────────────────────────────────────────

const RING_SIZE = 10 * 1024 // 10 KB

class RingBuffer {
  private buf: string[] = []
  private totalBytes = 0

  push(chunk: string): void {
    this.buf.push(chunk)
    this.totalBytes += chunk.length
    // Trim from front until under limit
    while (this.totalBytes > RING_SIZE && this.buf.length > 0) {
      const dropped = this.buf.shift()!
      this.totalBytes -= dropped.length
    }
  }

  snapshot(): string {
    return this.buf.join('')
  }
}

// ── Internal session record ───────────────────────────────────────────────────

interface SessionRecord {
  meta: PtySession
  pty: pty.IPty
  ring: RingBuffer
  /** 绑定的 BrowserWindow — stdout/exit 只推送给这个窗口 */
  window: BrowserWindow | null
  /** 外部订阅的 stdout 回调 */
  dataListeners: ((data: string) => void)[]
  /** 外部订阅的 exit 回调 */
  exitListeners: ((exitCode: number) => void)[]
  /** CLI 是否已就绪（输出了 input prompt） */
  cliReady: boolean
  /** resolve 当 CLI 就绪时 */
  cliReadyResolve: (() => void) | null
  /** 等待 CLI 就绪的 promise */
  cliReadyPromise: Promise<void>
}

// ── PTY Manager ──────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionRecord>()

export function spawnPtySession(opts: SpawnOptions): SpawnResult {
  const id = crypto.randomUUID()
  const cols = opts.cols ?? 200
  const rows = opts.rows ?? 50

  const effectiveCwd = opts.cwd ?? process.env['HOME'] ?? '/'

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn(opts.bin, opts.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: effectiveCwd,
      env: {
        ...process.env,
        // Force iTerm2 IIP path so CLI uses a protocol xterm.js can render
        TERM_PROGRAM: 'iTerm.app',
        COLORTERM: 'truecolor',
        TERM: 'xterm-256color',
        ...opts.env
      } as Record<string, string>
    })
  } catch (err) {
    return { ok: false, reason: String(err) }
  }

  const ring = new RingBuffer()
  const meta: PtySession = {
    id,
    agentId: opts.agentId,
    memberId: opts.memberId,
    cliName: opts.cliName,
    bin: opts.bin,
    status: 'running',
    cols,
    rows,
    startedAt: new Date().toISOString(),
    cwd: effectiveCwd
  }

  let cliReadyResolve: (() => void) | null = null
  const cliReadyPromise = new Promise<void>((resolve) => { cliReadyResolve = resolve })

  const record: SessionRecord = {
    meta, pty: ptyProcess, ring, window: null,
    dataListeners: [], exitListeners: [],
    cliReady: false, cliReadyResolve, cliReadyPromise
  }
  sessions.set(id, record)

  // CLI 就绪检测：匹配 Claude CLI 的输入 prompt
  // Claude CLI 在就绪时输出包含 "bypass permissions" 或 "shift+tab" 的提示行
  const CLI_READY_PATTERNS = [/bypass permissions/i, /shift\+tab/i]

  ptyProcess.onData((data) => {
    ring.push(data)

    // 检测 CLI 就绪
    if (!record.cliReady) {
      for (const pat of CLI_READY_PATTERNS) {
        if (pat.test(data)) {
          record.cliReady = true
          record.cliReadyResolve?.()
          record.cliReadyResolve = null
          break
        }
      }
    }

    // 只推送给绑定的窗口，而非广播全部
    if (record.window && !record.window.isDestroyed()) {
      record.window.webContents.send('pty-output', data)
    }
    // 通知外部订阅者
    for (const cb of record.dataListeners) {
      try { cb(data) } catch { /* ignore */ }
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (record.meta.status === 'running') {
      record.meta.status = 'exited'
    }
    record.meta.exitCode = exitCode
    // 通知绑定的窗口进程已退出
    if (record.window && !record.window.isDestroyed()) {
      record.window.webContents.send('pty-exit', id, exitCode)
    }
    // 通知外部 exit 订阅者
    for (const cb of record.exitListeners) {
      try { cb(exitCode) } catch { /* ignore */ }
    }
  })

  return { ok: true, sessionId: id }
}

/**
 * 绑定 session 到 BrowserWindow。
 * stdout/exit 事件只推送给绑定的窗口。
 * 返回 ring buffer 快照供初始回放。
 */
export function attachWindow(sessionId: string, win: BrowserWindow): { ok: true; buffer: string } | { ok: false; reason: string } {
  const rec = sessions.get(sessionId)
  if (!rec) return { ok: false, reason: 'session not found' }
  rec.window = win
  return { ok: true, buffer: rec.ring.snapshot() }
}

export function writeToPty(sessionId: string, data: string): boolean {
  const rec = sessions.get(sessionId)
  if (!rec || rec.meta.status !== 'running') return false
  rec.pty.write(data)
  return true
}

export function resizePty(sessionId: string, cols: number, rows: number): boolean {
  const rec = sessions.get(sessionId)
  if (!rec || rec.meta.status !== 'running') return false
  rec.pty.resize(cols, rows)
  rec.meta.cols = cols
  rec.meta.rows = rows
  return true
}

export function killPtySession(sessionId: string): boolean {
  const rec = sessions.get(sessionId)
  if (!rec) return false
  if (rec.meta.status === 'running') {
    rec.pty.kill()
    rec.meta.status = 'killed'
  }
  return true
}

export function getPtySessions(): PtySession[] {
  return Array.from(sessions.values()).map((r) => ({ ...r.meta }))
}

export function getPtySession(sessionId: string): PtySession | null {
  return sessions.get(sessionId)?.meta ?? null
}

/** Get ring buffer snapshot for a session (used when a new renderer window connects) */
export function getPtyBuffer(sessionId: string): string | null {
  return sessions.get(sessionId)?.ring.snapshot() ?? null
}

/**
 * 订阅 session 的 exit 事件。返回取消订阅函数。
 * 如果 session 已经退出，立即同步调用 callback。
 */
export function onSessionExit(sessionId: string, callback: (exitCode: number) => void): (() => void) | null {
  const rec = sessions.get(sessionId)
  if (!rec) return null
  // 如果 PTY 已经退出，立即回调
  if (rec.meta.status === 'exited' || rec.meta.status === 'killed') {
    callback(rec.meta.exitCode ?? -1)
    return () => {}
  }
  rec.exitListeners.push(callback)
  return () => {
    const idx = rec.exitListeners.indexOf(callback)
    if (idx !== -1) rec.exitListeners.splice(idx, 1)
  }
}

/**
 * 订阅 session 的 stdout 数据。返回取消订阅函数。
 */
export function onSessionData(sessionId: string, callback: (data: string) => void): (() => void) | null {
  const rec = sessions.get(sessionId)
  if (!rec) return null
  rec.dataListeners.push(callback)
  return () => {
    const idx = rec.dataListeners.indexOf(callback)
    if (idx !== -1) rec.dataListeners.splice(idx, 1)
  }
}

/**
 * 按成员名查找 session（返回第一个 running 状态的）
 */
export function getSessionByMemberId(memberId: string): PtySession | null {
  for (const rec of sessions.values()) {
    if (rec.meta.memberId === memberId && rec.meta.status === 'running') {
      return { ...rec.meta }
    }
  }
  return null
}

/**
 * 等待成员的 CLI 就绪（输出了 input prompt）。
 * 返回 true 表示就绪，false 表示超时。
 */
export async function waitForCliReady(memberId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  // 先等 session 出现
  let rec: SessionRecord | undefined
  while (Date.now() < deadline) {
    for (const r of sessions.values()) {
      if (r.meta.memberId === memberId && r.meta.status === 'running') {
        rec = r
        break
      }
    }
    if (rec) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!rec) return false

  // session 已存在，等 CLI ready
  if (rec.cliReady) return true

  const remaining = deadline - Date.now()
  if (remaining <= 0) return false

  return Promise.race([
    rec.cliReadyPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining))
  ])
}

/** Kill all running sessions — call on app before-quit */
export function killAllPtySessions(): void {
  for (const [, rec] of sessions) {
    if (rec.meta.status === 'running') {
      try { rec.pty.kill() } catch { /* ignore */ }
      rec.meta.status = 'killed'
    }
  }
}
