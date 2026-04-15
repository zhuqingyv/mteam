import { onSessionData, getPtyBuffer } from './pty-manager'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentState = 'IDLE' | 'BUSY' | 'UNKNOWN'

// ── Idle patterns ─────────────────────────────────────────────────────────────

// 匹配 Claude CLI prompt — 去除 ANSI 转义码后检测
// 覆盖 CSI 序列 (\x1b[...X) 和 OSC 序列 (\x1b]...\x07 或 \x1b]...\x1b\\)
// 含 private-mode 前缀 (?, >, =, !) 如 \x1b[?25h
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[?>=!]?[0-9;]*[a-zA-Z]/g

// 匹配两种 Claude CLI 空闲状态：
// 1. prompt 符号 ❯ 或 > 在末尾（普通模式）
// 2. 状态栏 "shift+tab to cycle)" 在末尾（bypass permissions 模式，❯ 在倒数第二行）
const IDLE_PATTERN = /(?:[❯>]\s*$|shift\+tab to cycle\)\s*$)/

// 等待无新数据多少 ms 后判为 IDLE
const IDLE_DEBOUNCE_MS = 500

// ── Factory ───────────────────────────────────────────────────────────────────

export function createIdleDetector(opts: {
  sessionId: string
  cliName: string
  onIdle: () => void
  onBusy: () => void
}): { destroy: () => void } {
  const { sessionId, onIdle, onBusy } = opts

  let state: AgentState = 'UNKNOWN'
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastChunk = ''

  function setState(next: AgentState): void {
    if (next === state) return
    state = next
    if (next === 'IDLE') onIdle()
    else if (next === 'BUSY') onBusy()
  }

  function cancelDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  function onData(data: string): void {
    lastChunk += data

    // 收到数据 → BUSY
    cancelDebounce()
    setState('BUSY')

    // 检测当前 chunk 末尾是否匹配 idle pattern
    const clean = lastChunk.replace(ANSI_RE, '')
    const trimmed = clean.trimEnd()
    const tail = trimmed.slice(-80)
    const matched = IDLE_PATTERN.test(trimmed)
    process.stderr.write(`[idle-det] onData sessionId=${sessionId}, cleanTail=${JSON.stringify(tail)}, matched=${matched}\n`)

    if (matched) {
      // 等 500ms 无新数据才切 IDLE
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        lastChunk = ''
        process.stderr.write(`[idle-det] debounce expired, setting IDLE for sessionId=${sessionId}\n`)
        setState('IDLE')
      }, IDLE_DEBOUNCE_MS)
    } else {
      // 重置 lastChunk，只保留最近 256 字符用于 pattern 检测
      if (lastChunk.length > 256) {
        lastChunk = lastChunk.slice(-256)
      }
    }
  }

  const unsubscribe = onSessionData(sessionId, onData)
  process.stderr.write(`[idle-det] created for sessionId=${sessionId}, subscribed=${unsubscribe !== null}\n`)

  // 方案 A：创建后立即读 ring buffer 尾部，如果已经是 idle 状态就启动 debounce
  const buf = getPtyBuffer(sessionId)
  if (buf) {
    const clean = buf.replace(ANSI_RE, '')
    const trimmed = clean.trimEnd()
    const tail = trimmed.slice(-80)
    if (IDLE_PATTERN.test(trimmed)) {
      process.stderr.write(`[idle-det] buffer tail matches idle pattern, starting debounce. tail=${JSON.stringify(tail)}\n`)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        lastChunk = ''
        process.stderr.write(`[idle-det] initial debounce expired, setting IDLE for sessionId=${sessionId}\n`)
        setState('IDLE')
      }, IDLE_DEBOUNCE_MS)
    } else {
      process.stderr.write(`[idle-det] buffer tail does NOT match idle pattern. tail=${JSON.stringify(tail)}\n`)
    }
  }

  return {
    destroy(): void {
      cancelDebounce()
      if (unsubscribe) unsubscribe()
    }
  }
}
