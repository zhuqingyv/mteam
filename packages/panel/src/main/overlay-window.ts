import { BrowserWindow, screen } from 'electron'
import { join } from 'path'

/**
 * Per-display overlay: one BrowserWindow per physical display.
 * Each overlay covers exactly one display, so its scaleFactor always matches,
 * eliminating DPR-induced coordinate offsets on mixed-DPR setups.
 */
interface OverlayEntry {
  win: BrowserWindow
  displayId: number
  originX: number
  originY: number
  width: number
  height: number
}

const overlays = new Map<number, OverlayEntry>()

function createOverlayForDisplay(display: Electron.Display): OverlayEntry {
  const b = display.bounds
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay-preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  const entry: OverlayEntry = {
    win,
    displayId: display.id,
    originX: b.x,
    originY: b.y,
    width: b.width,
    height: b.height,
  }

  win.once('ready-to-show', () => {
    if (process.env.E2E_HEADLESS !== '1') win.show()
    // Update origin to actual window position (macOS may adjust Y for menu bar)
    const actual = win.getBounds()
    const stored = overlays.get(display.id)
    if (stored) {
      stored.originX = actual.x
      stored.originY = actual.y
      process.stderr.write(`[overlay] actual origin for display ${display.id}: ${actual.x},${actual.y} (requested ${b.x},${b.y})\n`)
    }
  })

  win.on('closed', () => { overlays.delete(display.id) })

  process.stderr.write(`[overlay] created for display ${display.id}: ${b.x},${b.y} ${b.width}x${b.height} scale=${display.scaleFactor}\n`)
  return entry
}

/**
 * 初始创建：在主显示器上建一个 overlay，后续由 updateWindowPositions 按需增减。
 */
export function createOverlay(): BrowserWindow {
  const primary = screen.getPrimaryDisplay()
  const entry = createOverlayForDisplay(primary)
  overlays.set(primary.id, entry)
  return entry.win
}

/**
 * 返回第一个存活的 overlay 窗口（兼容旧调用方）。
 */
export function getOverlay(): BrowserWindow | null {
  for (const entry of overlays.values()) {
    if (!entry.win.isDestroyed()) return entry.win
  }
  return null
}

/**
 * 窗口位置更新时调用：
 * 1. 确保每个涉及的显示器都有一个 overlay 窗口
 * 2. 回收不再需要的 overlay
 * 3. 每个 overlay 只收到自己显示器上的终端窗口坐标（相对于该显示器原点）
 */
export function updateWindowPositions(positions: Array<{
  id: number
  memberName: string
  isLeader: boolean
  x: number
  y: number
  w: number
  h: number
  color: number[]
}>): void {
  if (positions.length === 0) {
    // 没有终端窗口 — 隐藏所有 overlay
    for (const entry of overlays.values()) {
      if (!entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide()
    }
    return
  }

  // 按显示器分组终端窗口
  const byDisplay = new Map<number, {
    display: Electron.Display
    positions: typeof positions
  }>()

  for (const p of positions) {
    const centerX = p.x + p.w / 2
    const centerY = p.y + p.h / 2
    const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
    let group = byDisplay.get(display.id)
    if (!group) {
      group = { display, positions: [] }
      byDisplay.set(display.id, group)
    }
    group.positions.push(p)
  }

  // 确保每个活跃显示器有 overlay
  const activeDisplayIds = new Set<number>()
  for (const [displayId, group] of byDisplay) {
    activeDisplayIds.add(displayId)

    let entry = overlays.get(displayId)
    if (!entry || entry.win.isDestroyed()) {
      entry = createOverlayForDisplay(group.display)
      overlays.set(displayId, entry)
    }

    // 检查显示器 bounds 是否变化（热插拔/分辨率切换）
    const db = group.display.bounds
    if (entry.width !== db.width || entry.height !== db.height) {
      entry.win.setBounds({ x: db.x, y: db.y, width: db.width, height: db.height })
      const actualBounds = entry.win.getBounds()
      entry.originX = actualBounds.x
      entry.originY = actualBounds.y
      entry.width = actualBounds.width
      entry.height = actualBounds.height
      process.stderr.write(`[overlay] display ${displayId} bounds updated: requested=${db.x},${db.y} actual=${actualBounds.x},${actualBounds.y} ${actualBounds.width}x${actualBounds.height}\n`)
    }

    if (!entry.win.isVisible() && process.env.E2E_HEADLESS !== '1') {
      entry.win.show()
      // show() can also adjust position on macOS — sync actual origin
      const actualBounds = entry.win.getBounds()
      entry.originX = actualBounds.x
      entry.originY = actualBounds.y
    }

    // 发送所有终端窗口坐标（相对于本 overlay 的显示器原点），
    // 包括其他显示器上的窗口，这样触手可以跨屏延伸
    const adjusted = positions.map(p => ({
      ...p,
      x: p.x - entry!.originX,
      y: p.y - entry!.originY
    }))

    entry.win.webContents.send('window-positions', adjusted)
  }

  // 隐藏不再需要的 overlay（终端窗口都离开了该显示器）
  for (const [displayId, entry] of overlays) {
    if (!activeDisplayIds.has(displayId) && !entry.win.isDestroyed()) {
      if (entry.win.isVisible()) entry.win.hide()
    }
  }
}

/** Send message events to all overlay renderers */
export function updateMessages(messages: Array<{
  from: string
  to: string
  startTime: number
  duration: number
}>): void {
  const now = performance.now() / 1000
  const converted = messages.map(msg => ({
    from: msg.from,
    to: msg.to,
    elapsed: now - msg.startTime,
    duration: msg.duration
  }))
  for (const entry of overlays.values()) {
    if (!entry.win.isDestroyed()) {
      entry.win.webContents.send('message-events', converted)
    }
  }
}
