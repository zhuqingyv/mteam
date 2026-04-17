import {
  enqueue,
  peekAll,
  consumeAll,
  clearQueue,
  expireSweep,
  type Message
} from './message-queue'
import { createReadyDetector } from './ready-detector'
import { getSessionByMemberId, writeToPty } from './pty-manager'
import { updateMessages } from './overlay-window'

export type { Message }

// ── Internal state ────────────────────────────────────────────────────────────

// memberId → { sessionId, destroy }
const readyDetectors = new Map<string, { sessionId: string; destroy: () => void }>()

// 已就绪的成员（ready-detector 触发后加入）
const readyMembers = new Set<string>()


// 消息 TTL：10 分钟
const MESSAGE_TTL_MS = 10 * 60 * 1000

// TTL sweep 定时器
let sweepTimer: ReturnType<typeof setInterval> | null = null

// ── Active message tracking for overlay tentacles ─────────────────────────────
interface ActiveMessage {
  from: string
  to: string
  startTime: number   // performance.now() / 1000, synced with overlay renderer clock
  duration: number     // seconds
}

const activeMessages: ActiveMessage[] = []
const MESSAGE_ANIMATION_DURATION = 3 // seconds

let activeMessageTimer: ReturnType<typeof setInterval> | null = null

/** Sweep expired active messages and push current list to overlay */
function tickActiveMessages(): void {
  const now = performance.now() / 1000
  // Remove expired
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    if (now - activeMessages[i].startTime > activeMessages[i].duration) {
      activeMessages.splice(i, 1)
    }
  }
  // If all messages expired, stop the timer and send one final empty update
  if (activeMessages.length === 0 && activeMessageTimer) {
    clearInterval(activeMessageTimer)
    activeMessageTimer = null
    updateMessages([])
    return
  }
  updateMessages(activeMessages)
}

/** Record a new active message for overlay animation */
function addActiveMessage(from: string, to: string): void {
  activeMessages.push({
    from,
    to,
    startTime: performance.now() / 1000,
    duration: MESSAGE_ANIMATION_DURATION
  })
  // Start tick timer on-demand if not already running
  if (!activeMessageTimer) {
    activeMessageTimer = setInterval(tickActiveMessages, 100)
  }
  tickActiveMessages()
}

// ── Role lookup (从 team-hub 成员目录读) ─────────────────────────────────────

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'

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
 * 名字解析：验证成员名是否存在。
 * 目录名 = profile.name = 汉字名，直接匹配。
 * 返回 null 表示成员不存在，调用方应返回错误而非静默入队。
 */
function resolveCallName(name: string): string | null {
  // 目录存在即有效
  const directPath = join(homedir(), '.claude/team-hub/members', name, 'profile.json')
  if (existsSync(directPath)) return name
  // 没找到，返回 null
  return null
}

// ── Envelope format ───────────────────────────────────────────────────────────

function formatEnvelope(msg: Message & { type?: string }): string {
  const role = getMemberRole(msg.from)
  const type = msg.type ?? 'reply'
  // 压成单行，避免多行 paste 提交问题
  const oneLine = msg.content.replace(/\n/g, ' ')
  return `[team-hub] ${msg.from}(${role}) → ${type}: ${oneLine}`
}

// ── PTY notification (peek-only, does NOT consume queue) ─────────────────────

function notifyViaPty(memberId: string): void {
  process.stderr.write(`[msg-router] notifyViaPty called for ${memberId}\n`)
  const session = getSessionByMemberId(memberId)
  if (!session) {
    process.stderr.write(`[msg-router] notifyViaPty: no session for ${memberId}, abort\n`)
    return
  }

  const pending = peekAll(memberId)
  if (pending.length === 0) {
    process.stderr.write(`[msg-router] notifyViaPty: queue empty for ${memberId}\n`)
    return
  }

  // 只发通知摘要，不消费队列。消息由 check_inbox (MCP) 消费。
  const summary = pending.map((m) => formatEnvelope(m)).join('\n')
  process.stderr.write(`[msg-router] notifyViaPty: writing ${pending.length} msg(s) to PTY ${session.id}\n`)
  writeToPty(session.id, summary)
  setTimeout(() => {
    writeToPty(session.id, '\r')
  }, 150)
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SendResult {
  id: string
  delivered: boolean
  error?: string
}

export function setupMessageRouter(): {
  sendMessage: (from: string, to: string, content: string, priority?: string) => SendResult
  getInbox: (memberId: string) => Message[]
  consumeInbox: (memberId: string) => Message[]
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
  ): SendResult {
    const p: 'normal' | 'urgent' =
      priority === 'urgent' ? 'urgent' : 'normal'

    // 名字解析统一在 Panel 端完成（Hub 端直接透传 to）
    const resolvedTo = resolveCallName(to)
    if (resolvedTo === null) {
      // 目标成员不存在，返回错误而不是静默入队
      process.stderr.write(`[msg-router] sendMessage: target '${to}' not found, reject\n`)
      return { id: '', delivered: false, error: `目标成员 '${to}' 不存在` }
    }

    const id = enqueue({ from, to: resolvedTo, content, priority: p })
    process.stderr.write(`[msg-router] sendMessage: from=${from}, to=${to}(resolved=${resolvedTo}), content=${content.slice(0, 50)}\n`)

    // Notify overlay for tentacle animation
    addActiveMessage(from, resolvedTo)

    // 如果目标成员已就绪且有 PTY session，通过 PTY 发送通知（不消费队列）
    // 消息保留在队列中，由成员调 check_inbox 消费
    let delivered = false
    if (readyMembers.has(resolvedTo)) {
      const session = getSessionByMemberId(resolvedTo)
      if (session) {
        notifyViaPty(resolvedTo)
        delivered = true
      }
    }

    return { id, delivered }
  }

  function getInbox(memberId: string): Message[] {
    return peekAll(memberId)
  }

  /**
   * 消费收件箱：读取所有消息并清空队列。
   * check_inbox 的唯一消费路径，PTY 通知只读不消费。
   */
  function consumeInbox(memberId: string): Message[] {
    return consumeAll(memberId)
  }

  function clearInbox(memberId: string): void {
    clearQueue(memberId)
  }

  return { sendMessage, getInbox, consumeInbox, clearInbox }
}

/**
 * 成员 CLI 就绪后调用：创建 ready detector，onReady 时通过 PTY 通知积压消息。
 * 消息保留在队列中，由成员通过 MCP check_inbox 消费。
 */
export function onMemberReady(memberId: string): void {
  const session = getSessionByMemberId(memberId)
  if (!session) {
    process.stderr.write(`[msg-router] onMemberReady: no session for ${memberId}, skip\n`)
    return
  }

  process.stderr.write(`[msg-router] onMemberReady: ${memberId} ready, sessionId=${session.id}\n`)

  // 如果已有 detector 且 session 没变，跳过
  const existing = readyDetectors.get(memberId)
  if (existing) {
    if (existing.sessionId === session.id) return
    // session 变了，销毁旧的
    existing.destroy()
    readyDetectors.delete(memberId)
  }

  const detector = createReadyDetector({
    sessionId: session.id,
    onReady: () => {
      process.stderr.write(`[msg-router] onReady fired for ${memberId}, marking ready + notifying\n`)
      readyMembers.add(memberId)
      // 就绪时通过 PTY 通知有积压消息（不消费队列）
      notifyViaPty(memberId)
    }
  })

  readyDetectors.set(memberId, { sessionId: session.id, destroy: detector.destroy })
}

export function teardownMessageRouter(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  if (activeMessageTimer) {
    clearInterval(activeMessageTimer)
    activeMessageTimer = null
  }
  activeMessages.length = 0
  for (const [, entry] of readyDetectors) {
    entry.destroy()
  }
  readyDetectors.clear()
  readyMembers.clear()
}
