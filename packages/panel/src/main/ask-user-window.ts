import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type AskUserType = 'confirm' | 'single_choice' | 'multi_choice' | 'input'

export interface AskUserRequest {
  id: string
  member_name: string
  type: AskUserType
  title: string
  question: string
  options?: string[]
  timeout_ms: number
  created_at: number
}

export interface AskUserResponse {
  answered: boolean
  choice?: string | string[]
  input?: string
  reason?: 'timeout' | 'cancelled'
}

// ── Internal state ──────────────────────────────────────────────────────────

interface PendingRequest {
  request: AskUserRequest
  win: BrowserWindow | null
  timer: ReturnType<typeof setTimeout> | null
  resolve: (response: AskUserResponse) => void
}

const MAX_VISIBLE = 3
const STACK_OFFSET_X = 10
const STACK_OFFSET_Y = 20
const DEFAULT_TIMEOUT_MS = 120_000

const visibleStack: PendingRequest[] = []
const waitingQueue: PendingRequest[] = []

let requestCounter = 0

// ── Public API ──────────────────────────────────────────────────────────────

export function createAskUserRequest(params: {
  member_name: string
  type: AskUserType
  title: string
  question: string
  options?: string[]
  timeout_ms?: number
}): Promise<AskUserResponse> {
  const id = `ask_${Date.now()}_${++requestCounter}`
  const request: AskUserRequest = {
    id,
    member_name: params.member_name,
    type: params.type,
    title: params.title,
    question: params.question,
    options: params.options,
    timeout_ms: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    created_at: Date.now(),
  }

  return new Promise<AskUserResponse>((resolve) => {
    const pending: PendingRequest = { request, win: null, timer: null, resolve }

    if (visibleStack.length < MAX_VISIBLE) {
      showRequest(pending)
    } else {
      waitingQueue.push(pending)
    }
  })
}

// ── Window creation ─────────────────────────────────────────────────────────

function calcWindowPosition(
  stackIndex: number,
  winWidth: number,
  winHeight: number,
): { x: number; y: number } | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  const allWindows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const anchor = focused ?? allWindows[0]
  if (!anchor || anchor.isDestroyed()) return undefined

  const [anchorX, anchorY] = anchor.getPosition()
  const [anchorW, anchorH] = anchor.getSize()

  // Center relative to anchor
  let x = anchorX + Math.round((anchorW - winWidth) / 2) + stackIndex * STACK_OFFSET_X
  let y = anchorY + Math.round((anchorH - winHeight) / 2) + stackIndex * STACK_OFFSET_Y

  // Clamp to screen
  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea
  if (x + winWidth > sx + sw) x = sx + sw - winWidth
  if (y + winHeight > sy + sh) y = sy + sh - winHeight
  if (x < sx) x = sx
  if (y < sy) y = sy

  return { x, y }
}

function showRequest(pending: PendingRequest): void {
  visibleStack.push(pending)
  const stackIndex = visibleStack.length - 1

  const winWidth = 420
  const winHeight = 360
  const pos = calcWindowPosition(stackIndex, winWidth, winHeight)

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    minWidth: 360,
    minHeight: 280,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/ask-user-preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  pending.win = win

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/ask-user.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/ask-user.html'))
  }

  win.once('ready-to-show', () => {
    if (process.env.E2E_HEADLESS !== '1') win.show()
    // Send the request data to the renderer
    win.webContents.send('show-ask-user', pending.request)
  })

  // Start timeout timer
  pending.timer = setTimeout(() => {
    resolveRequest(pending, { answered: false, reason: 'timeout' })
  }, pending.request.timeout_ms)

  // If user closes the window manually
  win.on('closed', () => {
    // Only resolve if not already resolved
    if (visibleStack.includes(pending) || waitingQueue.includes(pending)) {
      resolveRequest(pending, { answered: false, reason: 'cancelled' })
    }
  })
}

// ── Resolution ──────────────────────────────────────────────────────────────

function resolveRequest(pending: PendingRequest, response: AskUserResponse): void {
  // Clear timer
  if (pending.timer) {
    clearTimeout(pending.timer)
    pending.timer = null
  }

  // Remove from visible stack
  const visIdx = visibleStack.indexOf(pending)
  if (visIdx !== -1) {
    visibleStack.splice(visIdx, 1)
  }

  // Remove from waiting queue (if somehow there)
  const qIdx = waitingQueue.indexOf(pending)
  if (qIdx !== -1) {
    waitingQueue.splice(qIdx, 1)
  }

  // Close window
  if (pending.win && !pending.win.isDestroyed()) {
    pending.win.close()
  }

  // Resolve the promise
  pending.resolve(response)

  // Show next from queue if slot available
  while (visibleStack.length < MAX_VISIBLE && waitingQueue.length > 0) {
    const next = waitingQueue.shift()!
    showRequest(next)
  }
}

// ── IPC handlers ────────────────────────────────────────────────────────────

export function setupAskUserIpc(): void {
  // Renderer → Main: user submitted an answer
  ipcMain.on('ask-user-response', (_event, requestId: string, response: {
    choice?: string | string[]
    input?: string
  }) => {
    const pending = visibleStack.find((p) => p.request.id === requestId)
    if (!pending) return
    resolveRequest(pending, {
      answered: true,
      choice: response.choice,
      input: response.input,
    })
  })

  // Renderer → Main: user cancelled
  ipcMain.on('ask-user-cancel', (_event, requestId: string) => {
    const pending = visibleStack.find((p) => p.request.id === requestId)
    if (!pending) return
    resolveRequest(pending, { answered: false, reason: 'cancelled' })
  })

  // Renderer → Main: get request data (for when renderer loads after show-ask-user)
  ipcMain.handle('ask-user-get-request', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const pending = visibleStack.find((p) => p.win?.id === win.id)
    return pending?.request ?? null
  })
}
