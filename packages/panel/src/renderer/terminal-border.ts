// ── Liquid SDF Border Renderer for Terminal Windows ──────────────────────────
// Renders an animated liquid border effect on a full-screen canvas overlay.
// Uses SDF (Signed Distance Field) with wobble animation for organic feel.

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

const canvas = document.getElementById('border-canvas') as HTMLCanvasElement
if (!canvas) throw new Error('border-canvas not found')

const ctx = canvas.getContext('2d')!
let W = 0
let H = 0

// ── Configuration ────────────────────────────────────────────────────────────
const CORNER_RADIUS = 8   // match CSS border-radius of titlebar/terminal
const BW = 4          // border width
const RES = 2          // downsampling factor for performance

// Member color — loaded async from main process, fallback to URL param or default
let memberColor: number[] = [100, 180, 255]

async function loadColor(): Promise<void> {
  // Try preload bridge first
  if (window.terminalBridge?.getMemberColor) {
    try {
      const color = await window.terminalBridge.getMemberColor()
      if (Array.isArray(color) && color.length === 3) {
        memberColor = color
        return
      }
    } catch { /* fall through */ }
  }

  // Fallback: URL query parameter ?color=R,G,B
  const params = new URLSearchParams(window.location.search)
  const colorParam = params.get('color')
  if (colorParam) {
    const parts = colorParam.split(',').map(Number)
    if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
      memberColor = parts
    }
  }
}

// ── Resize handling ──────────────────────────────────────────────────────────
let DPR = 1
function resize(): void {
  DPR = window.devicePixelRatio || 1
  W = Math.round(window.innerWidth * DPR)
  H = Math.round(window.innerHeight * DPR)
  canvas.width = W
  canvas.height = H
}

resize()
window.addEventListener('resize', resize)

// ── SDF: Rounded rectangle ──────────────────────────────────────────────────
// Returns negative inside, positive outside
function roundedBoxSDF(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const cx = x + w / 2
  const cy = y + h / 2
  const dx = Math.abs(px - cx) - w / 2 + r
  const dy = Math.abs(py - cy) - h / 2 + r
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
}

// ── Border field with wobble animation ──────────────────────────────────────
function borderField(px: number, py: number, time: number): number {
  // SDF box matches the content area exactly: CSS margin=8px on all sides
  // Content spans from (8, 8) to (innerW-8, innerH-8) in CSS pixels
  const margin = 8 * DPR
  const contentRadius = CORNER_RADIUS * DPR

  const boxX = margin
  const boxY = margin
  const boxW = W - margin * 2
  const boxH = H - margin * 2

  const sdf = roundedBoxSDF(px, py, boxX, boxY, boxW, boxH, contentRadius)

  // Compute wobble based on angle from center
  const cx = W / 2
  const cy = H / 2
  const angle = Math.atan2(py - cy, px - cx)
  const wobble =
    Math.sin(angle * 5 + time * 1.5) * 1.0 * DPR +
    Math.sin(angle * 8 + time * 2.3) * 0.6 * DPR +
    Math.sin(angle * 13 + time * 1.1) * 0.4 * DPR

  const halfW = BW * DPR / 2 + wobble

  // Distance from the border "band"
  const d = Math.abs(sdf) - halfW

  // Smooth falloff
  const edge = 2 * DPR
  if (d > edge) return 0
  if (d < -edge) return 1
  return 1 - (d + edge) / (edge * 2)
}

// ── Main render loop ─────────────────────────────────────────────────────────
function draw(ts: number): void {
  const time = ts / 1000

  if (W === 0 || H === 0) {
    requestAnimationFrame(draw)
    return
  }

  const imgData = ctx.createImageData(W, H)
  const data = imgData.data

  // Transparent background (RGBA all zeros)
  // ImageData is already initialized to 0,0,0,0

  const [cr, cg, cb] = memberColor

  const rW = Math.ceil(W / RES)
  const rH = Math.ceil(H / RES)

  for (let ry = 0; ry < rH; ry++) {
    const py = ry * RES
    for (let rx = 0; rx < rW; rx++) {
      const px = rx * RES

      const val = borderField(px, py, time)
      if (val < 0.01) continue

      const alpha = Math.min(val, 1) * 0.85
      const r = Math.round(cr * alpha)
      const g = Math.round(cg * alpha)
      const b = Math.round(cb * alpha)
      const a = Math.round(alpha * 255)

      // Paint RES x RES block
      for (let dy = 0; dy < RES && py + dy < H; dy++) {
        for (let dx = 0; dx < RES && px + dx < W; dx++) {
          const idx = ((py + dy) * W + (px + dx)) * 4
          data[idx] = r
          data[idx + 1] = g
          data[idx + 2] = b
          data[idx + 3] = a
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0)
  requestAnimationFrame(draw)
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadColor().then(() => {
  requestAnimationFrame(draw)
})

export {}
