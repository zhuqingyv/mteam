import {
  enqueue,
  dequeue,
  peekAll,
  clearQueue,
  expireSweep,
  type Message
} from './message-queue'
import { createIdleDetector } from './idle-detector'
import {
  getSessionByMemberId,
  writeToPty,
  getPtySessions,
  getPtyBuffer
} from './pty-manager'

export type { Message }

// ── Internal state ────────────────────────────────────────────────────────────

// memberId → detector destroy fn
const detectors = new Map<string, () => void>()

// 消息 TTL：10 分钟
const MESSAGE_TTL_MS = 10 * 60 * 1000

// TTL sweep 定时器
let sweepTimer: ReturnType<typeof setInterval> | null = null

// ── Role lookup (从 team-hub 成员目录读) ─────────────────────────────────────

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'

function getMemberRole(memberName: string): string {
  const profilePath = join(homedir(), '.claude/team-hub/members', memberName, 'profile.json')
  if (!existsSync(profilePath)) return memberName
  try {
    const profile = JSON.parse(readFileSync(profilePath, 'utf-8')) as { role?: string }
    return profile.role ?? memberName
  } catch {
    return memberName
  }
}

/**
 * 名字解析：将 display_name 或 call_name 统一解析为 call_name。
 * PTY session 的 memberId 用的是 call_name（目录名），消息路由必须对齐。
 */
function resolveCallName(nameOrDisplay: string): string {
  // 如果已经是有效的 call_name（目录存在），直接返回
  const directPath = join(homedir(), '.claude/team-hub/members', nameOrDisplay, 'profile.json')
  if (existsSync(directPath)) return nameOrDisplay

  // 按 display_name 扫描
  const membersDir = join(homedir(), '.claude/team-hub/members')
  if (!existsSync(membersDir)) return nameOrDisplay
  try {
    const dirs = readdirSync(membersDir).filter((d) =>
      statSync(join(membersDir, d)).isDirectory()
    )
    for (const dir of dirs) {
      const pPath = join(membersDir, dir, 'profile.json')
      if (!existsSync(pPath)) continue
      try {
        const profile = JSON.parse(readFileSync(pPath, 'utf-8')) as { display_name?: string }
        if (profile.display_name === nameOrDisplay) {
          process.stderr.write(`[msg-router] resolved display_name "${nameOrDisplay}" → call_name "${dir}"\n`)
          return dir
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return nameOrDisplay
}

// ── Envelope format ───────────────────────────────────────────────────────────

function formatEnvelope(msg: Message): string {
  const role = getMemberRole(msg.from)
  return `[team-hub] 来自 ${msg.from}(${role}):\n${msg.content}\n---END---\n`
}

// ── Flush: dequeue and inject into PTY ───────────────────────────────────────

function flushQueue(memberId: string): void {
  process.stderr.write(`[msg-router] flushQueue called for ${memberId}\n`)
  const session = getSessionByMemberId(memberId)
  if (!session) {
    process.stderr.write(`[msg-router] flushQueue: no session for ${memberId}, abort\n`)
    return
  }

  const msg = dequeue(memberId)
  if (!msg) {
    process.stderr.write(`[msg-router] flushQueue: queue empty for ${memberId}\n`)
    return
  }

  const envelope = formatEnvelope(msg)
  process.stderr.write(`[msg-router] flushQueue: writing to PTY ${session.id}, msg from ${msg.from}, len=${envelope.length}\n`)
  writeToPty(session.id, envelope + '\r')
}

// ── Ensure detector exists for a session ─────────────────────────────────────

function ensureDetector(memberId: string, sessionId: string, cliName: string): void {
  if (detectors.has(memberId)) {
    process.stderr.write(`[msg-router] ensureDetector: ${memberId} already has detector, skip\n`)
    return
  }

  process.stderr.write(`[msg-router] ensureDetector: creating detector for ${memberId}, sessionId=${sessionId}\n`)

  const detector = createIdleDetector({
    sessionId,
    cliName,
    onIdle: () => {
      process.stderr.write(`[msg-router] onIdle fired for ${memberId}\n`)
      flushQueue(memberId)
    },
    onBusy: () => {
      // 无需处理
    }
  })

  detectors.set(memberId, detector.destroy)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function setupMessageRouter(): {
  sendMessage: (from: string, to: string, content: string, priority?: string) => string
  getInbox: (memberId: string) => Message[]
  clearInbox: (memberId: string) => void
} {
  // 启动 TTL sweep（每分钟）
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      expireSweep(MESSAGE_TTL_MS)
    }, 60_000)
  }

  function sendMessage(
    from: string,
    to: string,
    content: string,
    priority?: string
  ): string {
    const p: 'normal' | 'urgent' =
      priority === 'urgent' ? 'urgent' : 'normal'

    // 解析 to 为 call_name，确保与 PTY session 的 memberId 一致
    const resolvedTo = resolveCallName(to)
    const id = enqueue({ from, to: resolvedTo, content, priority: p })
    process.stderr.write(`[msg-router] sendMessage: from=${from}, to=${to}(resolved=${resolvedTo}), content=${content.slice(0, 50)}\n`)

    // 确保目标成员有 idle-detector，空闲时自动 flush 队列
    const session = getSessionByMemberId(resolvedTo)
    process.stderr.write(`[msg-router] sendMessage: session for ${resolvedTo} = ${session ? session.id : 'NULL'}\n`)
    if (session) {
      ensureDetector(resolvedTo, session.id, session.cliName)
    }

    return id
  }

  function getInbox(memberId: string): Message[] {
    return peekAll(memberId)
  }

  function clearInbox(memberId: string): void {
    clearQueue(memberId)
  }

  return { sendMessage, getInbox, clearInbox }
}

// 用于 syncDetectors 兜底检查的 idle 匹配（与 idle-detector.ts 一致）
const SYNC_ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[a-zA-Z]/g
const SYNC_IDLE_PATTERN = /(?:[❯>]\s*$|shift\+tab to cycle\)\s*$)/

/**
 * 当新 PTY session 出现时，补注册探测器。
 * 在 pty-manager spawn 之后调用（index.ts 每 5 秒调用）。
 * 方案 C 补充：顺带检查 buffer 尾部，如果已经 idle 且队列有消息就立即 flush。
 */
export function syncDetectors(): void {
  const runningSessions = getPtySessions().filter((s) => s.status === 'running')
  if (runningSessions.length > 0) {
    process.stderr.write(`[msg-router] syncDetectors: ${runningSessions.length} running sessions, detectors=${detectors.size}\n`)
  }
  for (const session of runningSessions) {
    ensureDetector(session.memberId, session.id, session.cliName)

    // 兜底：检查 buffer 尾部，如果 CLI 已 idle 且队列有消息，直接 flush
    const pending = peekAll(session.memberId)
    if (pending.length > 0) {
      const buf = getPtyBuffer(session.id)
      if (buf) {
        const clean = buf.replace(SYNC_ANSI_RE, '')
        if (SYNC_IDLE_PATTERN.test(clean.trimEnd())) {
          process.stderr.write(`[msg-router] syncDetectors: ${session.memberId} is idle with ${pending.length} pending msgs, flushing\n`)
          flushQueue(session.memberId)
        }
      }
    }
  }

  // 清理已无效 session 的探测器
  for (const [memberId, destroy] of detectors) {
    const stillRunning = runningSessions.some((s) => s.memberId === memberId)
    if (!stillRunning) {
      destroy()
      detectors.delete(memberId)
    }
  }
}

/**
 * 成员 CLI 就绪后调用：注册 detector + 立即检查留言队列。
 * 此时 session 已注册到 pty-manager，getSessionByMemberId 必能找到。
 */
export function onMemberReady(memberId: string): void {
  const session = getSessionByMemberId(memberId)
  if (!session) {
    process.stderr.write(`[msg-router] onMemberReady: no session for ${memberId}, skip\n`)
    return
  }

  process.stderr.write(`[msg-router] onMemberReady: ${memberId} ready, sessionId=${session.id}\n`)

  // 注册 idle detector（如果尚未注册）
  ensureDetector(memberId, session.id, session.cliName)

  // 立即检查留言队列，若 CLI 已 idle 则直接投递
  const pending = peekAll(memberId)
  if (pending.length > 0) {
    const buf = getPtyBuffer(session.id)
    if (buf) {
      const clean = buf.replace(SYNC_ANSI_RE, '')
      if (SYNC_IDLE_PATTERN.test(clean.trimEnd())) {
        process.stderr.write(`[msg-router] onMemberReady: ${memberId} is idle with ${pending.length} pending msgs, flushing\n`)
        flushQueue(memberId)
      } else {
        process.stderr.write(`[msg-router] onMemberReady: ${memberId} has ${pending.length} pending msgs but not idle yet, detector will handle\n`)
      }
    }
  }
}

export function teardownMessageRouter(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  for (const [, destroy] of detectors) {
    destroy()
  }
  detectors.clear()
}
