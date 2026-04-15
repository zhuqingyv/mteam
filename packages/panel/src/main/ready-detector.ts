import { onSessionData } from './pty-manager'

/** 首次输出后等待 CLI 完全初始化的延迟 (ms) */
const READY_DELAY_MS = 5_000

/** 超时兜底 (ms) — 30 秒内未收到任何输出则强制触发 */
const TIMEOUT_MS = 30_000

/**
 * 创建就绪检测器。
 *
 * 监听 PTY 输出，首次收到数据后延迟 5 秒触发 onReady（等 CLI 初始化完）。
 * 30 秒无输出则超时强制触发。
 */
export function createReadyDetector(opts: {
  sessionId: string
  onReady: () => void
}): { destroy: () => void } {
  const { sessionId, onReady } = opts

  let destroyed = false
  let fired = false
  let started = false
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  function fire(): void {
    if (fired || destroyed) return
    fired = true
    cleanup()
    process.stderr.write(`[ready-det] READY fired for sessionId=${sessionId}\n`)
    onReady()
  }

  function cleanup(): void {
    if (delayTimer !== null) {
      clearTimeout(delayTimer)
      delayTimer = null
    }
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  function onData(_data: string): void {
    if (started || fired || destroyed) return
    started = true
    // 首次输出 → 等 CLI 完全初始化后再触发
    process.stderr.write(`[ready-det] first output detected, waiting ${READY_DELAY_MS}ms for sessionId=${sessionId}\n`)
    delayTimer = setTimeout(() => {
      delayTimer = null
      fire()
    }, READY_DELAY_MS)
  }

  let unsubscribe: (() => void) | null = onSessionData(sessionId, onData)

  // 超时兜底
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null
    process.stderr.write(
      `[ready-det] timeout (${TIMEOUT_MS}ms) reached for sessionId=${sessionId}, forcing ready\n`
    )
    fire()
  }, TIMEOUT_MS)

  process.stderr.write(
    `[ready-det] created for sessionId=${sessionId}, subscribed=${unsubscribe !== null}\n`
  )

  return {
    destroy(): void {
      if (destroyed) return
      destroyed = true
      cleanup()
      process.stderr.write(`[ready-det] destroyed for sessionId=${sessionId}\n`)
    }
  }
}
