import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ── IPC bridge exposed by preload ─────────────────────────────────────────────
declare global {
  interface Window {
    terminalBridge: {
      onPtyOutput: (cb: (data: string) => void) => void
      sendInput: (data: string) => void
      notifyReady: (cols: number, rows: number) => void
      notifyResize: (cols: number, rows: number) => void
      getMemberColor: () => Promise<number[]>
      getMemberName: () => Promise<string>
      closeWindow: () => void
    }
  }
}

// ── Init terminal ─────────────────────────────────────────────────────────────
const term = new Terminal({
  theme: {
    background: '#0d0d0d',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: 'rgba(255,255,255,0.2)',
    black: '#1e1e1e',
    red: '#f44747',
    green: '#4ec9b0',
    yellow: '#dcdcaa',
    blue: '#569cd6',
    magenta: '#c586c0',
    cyan: '#9cdcfe',
    white: '#d4d4d4',
    brightBlack: '#808080',
    brightRed: '#f44747',
    brightGreen: '#4ec9b0',
    brightYellow: '#dcdcaa',
    brightBlue: '#569cd6',
    brightMagenta: '#c586c0',
    brightCyan: '#9cdcfe',
    brightWhite: '#ffffff'
  },
  fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Cascadia Mono', 'Consolas', monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000
})

const fitAddon = new FitAddon()
term.loadAddon(fitAddon)
term.loadAddon(new WebLinksAddon())

const container = document.getElementById('terminal')!
term.open(container)
fitAddon.fit()

// ── Activity tracking (byte rate → border intensity) ─────────────────────────
const ACTIVITY_WINDOW_MS = 1000
const ACTIVITY_MAX_BPS = 2000
const byteLog: { ts: number; bytes: number }[] = []
let currentActivity = 0
;(window as any).__borderActivity = 0

function updateActivity(): void {
  const now = performance.now()
  // Prune entries older than the sliding window
  while (byteLog.length > 0 && now - byteLog[0].ts > ACTIVITY_WINDOW_MS) {
    byteLog.shift()
  }
  const totalBytes = byteLog.reduce((sum, e) => sum + e.bytes, 0)
  const target = Math.min(totalBytes / ACTIVITY_MAX_BPS, 1)
  // Asymmetric easing: rise fast (~150ms), fall slow (~600ms)
  const alpha = target > currentActivity ? 0.15 : 0.04
  currentActivity += (target - currentActivity) * alpha
  ;(window as any).__borderActivity = currentActivity
  requestAnimationFrame(updateActivity)
}
requestAnimationFrame(updateActivity)

// ── IPC wiring ────────────────────────────────────────────────────────────────
if (window.terminalBridge) {
  // Receive PTY output
  window.terminalBridge.onPtyOutput((data: string) => {
    term.write(data)
    byteLog.push({ ts: performance.now(), bytes: data.length })
  })

  // Send keyboard input to PTY
  term.onData((data: string) => {
    window.terminalBridge.sendInput(data)
  })

  // Notify main of initial size
  window.terminalBridge.notifyReady(term.cols, term.rows)

  // Ensure xterm has keyboard focus on first show
  term.focus()
} else {
  // Dev fallback: show a message so the window isn't blank
  term.write('\x1b[33mTerminal bridge not available (dev mode)\x1b[0m\r\n')
}

// ── Resize handling ───────────────────────────────────────────────────────────
let resizeTimer: ReturnType<typeof setTimeout> | null = null
const resizeObserver = new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    fitAddon.fit()
  }, 150)
})
resizeObserver.observe(container)

term.onResize(({ cols, rows }) => {
  if (window.terminalBridge) {
    window.terminalBridge.notifyResize(cols, rows)
  }
})

// ── Image paste support ──────────────────────────────────────────────────────
// Claude CLI uses Ctrl+V (0x16) to trigger imagePaste, then reads system clipboard.
// When user pastes an image via Cmd+V in Electron, intercept and send 0x16 instead.
document.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items
  const hasImage = items && Array.from(items).some(i => i.type.startsWith('image/'))

  if (hasImage && window.terminalBridge) {
    e.preventDefault()
    e.stopPropagation()
    window.terminalBridge.sendInput('\x16')
  }
  // Pure text paste: let xterm.js handle normally
}, true)  // capture phase to intercept before xterm.js

// ── Titlebar ──────────────────────────────────────────────────────────────────
const closeBtn = document.getElementById('btn-close')
if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    window.terminalBridge?.closeWindow()
  })
}

// Set member name in titlebar via IPC
const titleLabel = document.getElementById('titlebar-label')
if (titleLabel && window.terminalBridge?.getMemberName) {
  window.terminalBridge.getMemberName().then((name: string) => {
    titleLabel.textContent = name || '成员'
  })
}
