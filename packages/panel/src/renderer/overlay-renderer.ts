declare global {
  interface Window {
    overlayBridge: {
      onWindowPositions: (cb: (positions: any[]) => void) => void
      onMessageEvents: (cb: (messages: any[]) => void) => void
    }
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

let W = 0, H = 0
let DPR = window.devicePixelRatio || 1
function resize(): void {
  DPR = window.devicePixelRatio || 1
  // Canvas bitmap in physical pixels; CSS size stays at logical pixels
  W = canvas.width = Math.round(window.innerWidth * DPR)
  H = canvas.height = Math.round(window.innerHeight * DPR)
  canvas.style.width = window.innerWidth + 'px'
  canvas.style.height = window.innerHeight + 'px'
}
resize()
window.addEventListener('resize', resize)

// ── Data from main process ──

interface BoxInfo {
  id: number
  memberName: string
  x: number
  y: number
  w: number
  h: number
  color: number[]
}

interface MessageEvent {
  from: string
  to: string
  startTime: number
  duration: number
}

/** Wire format from main process (uses elapsed instead of startTime for clock sync) */
interface MessageEventWire {
  from: string
  to: string
  elapsed: number
  duration: number
}

let boxes: BoxInfo[] = []
let messages: MessageEvent[] = []

// ── On-demand render loop control ──
let rafId: number | null = null
let isRunning = false

function startLoop(): void {
  if (!isRunning) {
    isRunning = true
    rafId = requestAnimationFrame(draw)
  }
}

function stopLoop(): void {
  isRunning = false
}

window.overlayBridge.onWindowPositions(pos => {
  boxes = pos
  startLoop()
})
window.overlayBridge.onMessageEvents((msgs: MessageEventWire[]) => {
  // Rebuild local startTime from elapsed: startTime = localNow - elapsed
  const localNow = performance.now() / 1000
  messages = msgs.map(m => ({
    from: m.from,
    to: m.to,
    startTime: localNow - m.elapsed,
    duration: m.duration
  }))
  startLoop()
})

// ── SDF constants (base values in logical pixels, scaled by DPR at render time) ──

const BASE_CORNER_RADIUS = 12
const BASE_BW = 4
const BASE_RES = 3
const BEZIER_SAMPLES = 12

// Effective values — updated each frame with current DPR
let CORNER_RADIUS = BASE_CORNER_RADIUS
let BW = BASE_BW
let RES = BASE_RES

// ── SDF primitives (from demo/liquid-merge.html) ──

function roundedBoxSDF(px: number, py: number, b: BoxInfo): number {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const dx = Math.abs(px - cx) - b.w / 2 + CORNER_RADIUS
  const dy = Math.abs(py - cy) - b.h / 2 + CORNER_RADIUS
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - CORNER_RADIUS
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * h * k / 6
}

function distToCubicBezier(
  px: number, py: number,
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number
): { dist: number; t: number } {
  let minDist = Infinity
  let bestT = 0
  for (let i = 0; i <= BEZIER_SAMPLES; i++) {
    const t = i / BEZIER_SAMPLES
    const it = 1 - t
    const it2 = it * it
    const it3 = it2 * it
    const t2 = t * t
    const t3 = t2 * t
    const bx = it3 * p0x + 3 * it2 * t * p1x + 3 * it * t2 * p2x + t3 * p3x
    const by = it3 * p0y + 3 * it2 * t * p1y + 3 * it * t2 * p2y + t3 * p3y
    const d = Math.hypot(px - bx, py - by)
    if (d < minDist) {
      minDist = d
      bestT = t
    }
  }
  return { dist: minDist, t: bestT }
}

function tentacleSDF(
  px: number, py: number,
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number,
  reach: number
): { dist: number; t: number } {
  const { dist, t } = distToCubicBezier(px, py, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y)
  const rootWidth = BW * 1.2
  const midWidth = BW * 0.35
  const edgeFactor = 4 * (t - 0.5) * (t - 0.5) // 1 at t=0,1 ; 0 at t=0.5
  const width = midWidth + (rootWidth - midWidth) * edgeFactor
  const sdfDist = dist - width * Math.min(reach * 1.5, 1)
  return { dist: sdfDist, t }
}

function findEdgeExit(cx: number, cy: number, nx: number, ny: number, box: BoxInfo, maxDist: number): number {
  const step = 2 * DPR
  for (let s = 0; s < maxDist; s += step) {
    if (roundedBoxSDF(cx + nx * s, cy + ny * s, box) > 0) {
      return s
    }
  }
  return maxDist * 0.5
}

// ── Helper: find box by memberName ──

function boxByName(name: string): BoxInfo | undefined {
  return boxes.find(b => b.memberName === name)
}

// ── Tentacle data ──

interface TentacleInfo {
  ai: number
  bi: number
  reach: number
  p0x: number; p0y: number
  p1x: number; p1y: number
  p2x: number; p2y: number
  p3x: number; p3y: number
  minX: number; maxX: number
  minY: number; maxY: number
}

// ── Main render loop ──

function draw(ts: number): void {
  const time = ts / 1000

  // overlay 动态 resize 时需要同步 canvas 尺寸
  const expectedW = Math.round(window.innerWidth * (window.devicePixelRatio || 1))
  const expectedH = Math.round(window.innerHeight * (window.devicePixelRatio || 1))
  if (canvas.width !== expectedW || canvas.height !== expectedH) {
    resize()
  }

  // Scale SDF constants by DPR
  CORNER_RADIUS = BASE_CORNER_RADIUS * DPR
  BW = BASE_BW * DPR
  RES = Math.max(1, Math.round(BASE_RES * DPR))

  ctx.clearRect(0, 0, W, H)

  // Nothing to do without at least 2 boxes or active messages
  if (boxes.length < 2 || messages.length === 0) {
    stopLoop()
    return
  }

  // Scale box coordinates from logical pixels to physical pixels (canvas bitmap space)
  const scaledBoxes: BoxInfo[] = boxes.map(b => ({
    ...b,
    x: b.x * DPR,
    y: b.y * DPR,
    w: b.w * DPR,
    h: b.h * DPR,
  }))

  // Build pair reach matrix (indexed by box array position)
  const n = scaledBoxes.length
  const pairReach: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))

  const now = performance.now() / 1000
  for (const msg of messages) {
    const fromIdx = scaledBoxes.findIndex(b => b.memberName === msg.from)
    const toIdx = scaledBoxes.findIndex(b => b.memberName === msg.to)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) continue

    const mt = (now - msg.startTime) / msg.duration
    if (mt < 0 || mt > 1) continue
    const reach = Math.pow(Math.sin(mt * Math.PI), 0.65)
    pairReach[fromIdx][toIdx] = Math.max(pairReach[fromIdx][toIdx], reach)
    pairReach[toIdx][fromIdx] = Math.max(pairReach[toIdx][fromIdx], reach)
  }

  // Pre-compute active tentacle pairs and Bezier control points
  const tentacles: TentacleInfo[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairReach[i][j] < 0.02) continue
      const a = scaledBoxes[i], b = scaledBoxes[j]
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2
      const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
      const dx = bcx - acx, dy = bcy - acy
      const len = Math.hypot(dx, dy)
      if (len < 1) continue
      const nx = dx / len, ny = dy / len

      const aExit = findEdgeExit(acx, acy, nx, ny, a, len * 0.5)
      const bExit = findEdgeExit(bcx, bcy, -nx, -ny, b, len * 0.5)

      const p0x = acx + nx * aExit
      const p0y = acy + ny * aExit
      const p3x = bcx - nx * bExit
      const p3y = bcy - ny * bExit

      const gapLen = Math.hypot(p3x - p0x, p3y - p0y)
      if (gapLen < 5 * DPR) continue

      const perpX = -ny, perpY = nx
      const wobbleAmt = gapLen * 0.25
      const offset1 = Math.sin(time * 1.7 + i * 2.3 + j * 1.1) * wobbleAmt
                     + Math.sin(time * 2.9 + j * 3.1) * wobbleAmt * 0.4
      const offset2 = Math.sin(time * 2.1 + j * 1.7 + i * 2.9) * wobbleAmt
                     + Math.cos(time * 1.3 + i * 2.7) * wobbleAmt * 0.4

      const p1x = p0x + (p3x - p0x) * 0.33 + perpX * offset1
      const p1y = p0y + (p3y - p0y) * 0.33 + perpY * offset1
      const p2x = p0x + (p3x - p0x) * 0.67 + perpX * offset2
      const p2y = p0y + (p3y - p0y) * 0.67 + perpY * offset2

      tentacles.push({
        ai: i, bi: j, reach: pairReach[i][j],
        p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y,
        minX: Math.min(p0x, p1x, p2x, p3x) - BW * 3,
        maxX: Math.max(p0x, p1x, p2x, p3x) + BW * 3,
        minY: Math.min(p0y, p1y, p2y, p3y) - BW * 3,
        maxY: Math.max(p0y, p1y, p2y, p3y) + BW * 3,
      })
    }
  }

  // Early out: no active tentacles
  if (tentacles.length === 0) {
    stopLoop()
    return
  }

  // Compute global bounding box of all tentacles for minimal rendering area
  let globalMinX = Infinity, globalMinY = Infinity
  let globalMaxX = -Infinity, globalMaxY = -Infinity
  for (const t of tentacles) {
    if (t.minX < globalMinX) globalMinX = t.minX
    if (t.minY < globalMinY) globalMinY = t.minY
    if (t.maxX > globalMaxX) globalMaxX = t.maxX
    if (t.maxY > globalMaxY) globalMaxY = t.maxY
  }

  // Clamp to canvas
  const renderX0 = Math.max(0, Math.floor(globalMinX / RES) * RES)
  const renderY0 = Math.max(0, Math.floor(globalMinY / RES) * RES)
  const renderX1 = Math.min(W, Math.ceil(globalMaxX))
  const renderY1 = Math.min(H, Math.ceil(globalMaxY))
  const renderW = renderX1 - renderX0
  const renderH = renderY1 - renderY0

  if (renderW <= 0 || renderH <= 0) {
    stopLoop()
    return
  }

  // Create ImageData for the tentacle region only
  const imgData = ctx.createImageData(renderW, renderH)
  const data = imgData.data
  // All pixels start at RGBA(0,0,0,0) = fully transparent — correct for overlay

  for (let py = renderY0; py < renderY1; py += RES) {
    for (let px = renderX0; px < renderX1; px += RES) {

      // Step 1: Compute raw rounded-box SDF for each box
      const boxDists = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        boxDists[i] = roundedBoxSDF(px, py, scaledBoxes[i])
      }

      // Step 2: Per-box fused SDF = smin(box SDF, each of its tentacles)
      // This creates the "growing out of the border" bulge at roots
      const fusedDists = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        fusedDists[i] = boxDists[i]
      }

      // Track closest tentacle info for color gradient
      let closestTentT = -1
      let closestTentAi = -1
      let closestTentBi = -1
      let closestTentDist = Infinity

      for (const tent of tentacles) {
        // Bounding box quick reject
        if (px < tent.minX || px > tent.maxX || py < tent.minY || py > tent.maxY) continue

        const { dist: tSDF, t: bezierT } = tentacleSDF(px, py,
          tent.p0x, tent.p0y, tent.p1x, tent.p1y,
          tent.p2x, tent.p2y, tent.p3x, tent.p3y, tent.reach)

        // Track the closest tentacle for color interpolation
        if (tSDF < closestTentDist) {
          closestTentDist = tSDF
          closestTentT = bezierT
          closestTentAi = tent.ai
          closestTentBi = tent.bi
        }

        // Fuse tentacle into both endpoint boxes (root fusion k scales with DPR)
        const kRoot = 18 * DPR
        fusedDists[tent.ai] = smin(fusedDists[tent.ai], tSDF, kRoot)
        fusedDists[tent.bi] = smin(fusedDists[tent.bi], tSDF, kRoot)
      }

      // Step 3: Global SDF = smin across connected fused-box fields
      let globalSDF = Infinity
      let closestBox = -1
      let secondBox = -1
      let closestDist = Infinity
      let secondDist = Infinity

      for (let i = 0; i < n; i++) {
        const d = fusedDists[i]
        if (d < closestDist) {
          secondDist = closestDist
          secondBox = closestBox
          closestDist = d
          closestBox = i
        } else if (d < secondDist) {
          secondDist = d
          secondBox = i
        }
      }

      // If the two closest boxes have an active tentacle, smin-fuse them
      let hasTentacleLink = false
      if (closestBox >= 0 && secondBox >= 0) {
        for (const tent of tentacles) {
          if ((tent.ai === closestBox && tent.bi === secondBox) ||
              (tent.ai === secondBox && tent.bi === closestBox)) {
            hasTentacleLink = true
            break
          }
        }
      }

      if (hasTentacleLink) {
        globalSDF = smin(closestDist, secondDist, 14 * DPR)
      } else {
        globalSDF = closestDist
      }

      // Step 4: Render border from globalSDF with wobble
      if (closestBox < 0) continue
      const cb = scaledBoxes[closestBox]
      const ccx = cb.x + cb.w / 2, ccy = cb.y + cb.h / 2
      const angle = Math.atan2(py - ccy, px - ccx)
      const wobble = Math.sin(angle * 5 + time * 1.5) * 1.0
                   + Math.sin(angle * 8 + time * 2.3) * 0.6
                   + Math.sin(angle * 13 + time * 1.1) * 0.4
      const halfW = BW / 2 + wobble

      const d = Math.abs(globalSDF) - halfW
      const aa = 2 * DPR // anti-aliasing width in physical pixels
      let val: number
      if (d > aa) { val = 0 }
      else if (d < -aa) { val = 1 }
      else { val = 1 - (d + aa) / (aa * 2) }

      if (val < 0.01) continue

      // Step 5: Color — use Bezier t for gradient along tentacle path
      let totalR: number, totalG: number, totalB: number
      if (closestTentDist < BW * 2 && closestTentAi >= 0 && closestTentBi >= 0) {
        // Pixel is near a tentacle — use Bezier t for color gradient
        let colorT = closestTentT
        colorT = colorT * colorT * (3 - 2 * colorT) // smoothstep
        const cA = scaledBoxes[closestTentAi].color
        const cB = scaledBoxes[closestTentBi].color
        totalR = cA[0] * (1 - colorT) + cB[0] * colorT
        totalG = cA[1] * (1 - colorT) + cB[1] * colorT
        totalB = cA[2] * (1 - colorT) + cB[2] * colorT
      } else {
        // Not in tentacle range — use the closest box's own color
        const c = scaledBoxes[closestBox].color
        totalR = c[0]; totalG = c[1]; totalB = c[2]
      }

      const r = Math.round(totalR)
      const g = Math.round(totalG)
      const bl = Math.round(totalB)
      const alpha = Math.round(Math.min(val, 1) * 0.85 * 255)

      // Paint RES x RES block into local ImageData
      for (let dy = 0; dy < RES && py + dy < renderY1; dy++) {
        for (let dx = 0; dx < RES && px + dx < renderX1; dx++) {
          const lx = (px + dx) - renderX0
          const ly = (py + dy) - renderY0
          const idx = (ly * renderW + lx) * 4
          data[idx] = r
          data[idx + 1] = g
          data[idx + 2] = bl
          data[idx + 3] = alpha
        }
      }
    }
  }

  ctx.putImageData(imgData, renderX0, renderY0)
  rafId = requestAnimationFrame(draw)
}

export {} // ensure this is treated as a module
