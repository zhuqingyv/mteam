// ── WebGL2 Overlay Renderer: tentacles between terminal windows ──────────────

declare global {
  interface Window {
    overlayBridge: {
      onWindowPositions: (cb: (positions: any[]) => void) => void
      onMessageEvents: (cb: (messages: any[]) => void) => void
    }
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement
const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })!
if (!gl) throw new Error('WebGL2 not supported')

// ── Data from main process ──────────────────────────────────────────────────

interface BoxInfo {
  id: number; memberName: string; isLeader: boolean
  x: number; y: number; w: number; h: number
  color: number[]
}

interface MessageEvent {
  from: string; to: string; startTime: number; duration: number
}

interface MessageEventWire {
  from: string; to: string; elapsed: number; duration: number
}

let boxes: BoxInfo[] = []
let messages: MessageEvent[] = []

// On-demand render loop
let isRunning = false
function startLoop(): void {
  if (!isRunning) { isRunning = true; requestAnimationFrame(draw) }
}
function stopLoop(): void { isRunning = false }

window.overlayBridge.onWindowPositions(pos => { boxes = pos; startLoop() })
window.overlayBridge.onMessageEvents((msgs: MessageEventWire[]) => {
  const localNow = performance.now() / 1000
  messages = msgs.map(m => ({
    from: m.from, to: m.to,
    startTime: localNow - m.elapsed, duration: m.duration
  }))
  startLoop()
})

function resize(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  canvas.style.width = window.innerWidth + 'px'
  canvas.style.height = window.innerHeight + 'px'
  gl.viewport(0, 0, canvas.width, canvas.height)
}
resize()
window.addEventListener('resize', resize)

// ── Tentacle geometry (computed on CPU, passed as uniforms) ──────────────────

const MAX_TENTACLES = 8
const BEZIER_SAMPLES = 12

interface TentacleData {
  p0x: number; p0y: number; p1x: number; p1y: number
  p2x: number; p2y: number; p3x: number; p3y: number
  reach: number
  headPos: number; tailPos: number
  fuseSrc: number; fuseDst: number
  colorA: number[]; colorB: number[]
}

function findEdgeExit(
  cx: number, cy: number, nx: number, ny: number,
  bx: number, by: number, bw: number, bh: number,
  cornerR: number, maxDist: number, dpr: number
): number {
  const step = 2 * dpr
  for (let s = 0; s < maxDist; s += step) {
    const px = cx + nx * s, py = cy + ny * s
    // inline roundedBoxSDF
    const dx = Math.abs(px - (bx + bw / 2)) - bw / 2 + cornerR
    const dy = Math.abs(py - (by + bh / 2)) - bh / 2 + cornerR
    const sdf = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - cornerR
    if (sdf > 0) return s
  }
  return maxDist * 0.5
}

// ── Shaders ─────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`

// Fragment shader: evaluates SDF for up to MAX_TENTACLES tentacles + their endpoint boxes
// Layout per tentacle (8 vec4):
//   [0] = (p0.x, p0.y, p1.x, p1.y)
//   [1] = (p2.x, p2.y, p3.x, p3.y)
//   [2] = (reach, headPos, tailPos, fuseSrc)
//   [3] = (colorA.r, colorA.g, colorA.b, fuseDst)
//   [4] = (colorB.r, colorB.g, colorB.b, 0)
//   [5] = (srcBox.x, srcBox.y, srcBox.w, srcBox.h)
//   [6] = (dstBox.x, dstBox.y, dstBox.w, dstBox.h)
//   [7] = reserved
const FRAG = `#version 300 es
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform int u_tentCount;

uniform vec4 u_tent[${MAX_TENTACLES} * 8];

out vec4 o_color;

const float CORNER_R_BASE = 12.0;
const float BW_BASE = 4.0;
const int BEZIER_SAMPLES = 12;

float roundedBoxSDF(vec2 p, vec4 box, float cr) {
    vec2 center = box.xy + box.zw * 0.5;
    vec2 d = abs(p - center) - box.zw * 0.5 + cr;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - cr;
}

float safeSmin(float a, float b, float k) {
    if (k < 0.001) return min(a, b);
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * h * k / 6.0;
}

// Evaluate cubic bezier at parameter t
vec2 bezierAt(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float it = 1.0 - t;
    return it*it*it*p0 + 3.0*it*it*t*p1 + 3.0*it*t*t*p2 + t*t*t*p3;
}

// Returns vec3(dist, globalT, 0)
// Only samples the bezier in [tailPos, headPos] range
vec3 tentacleSDF(vec2 p, vec2 p0, vec2 p1, vec2 p2, vec2 p3,
                 float reach, float headPos, float tailPos, float bw) {
    float minDist = 1e10;
    float bestT = 0.0;
    float span = headPos - tailPos;
    if (span < 0.001) return vec3(1e10, 0.0, 0.0);

    for (int i = 0; i <= BEZIER_SAMPLES; i++) {
        float t = tailPos + float(i) / float(BEZIER_SAMPLES) * span;
        vec2 b = bezierAt(p0, p1, p2, p3, t);
        float d = length(p - b);
        if (d < minDist) { minDist = d; bestT = t; }
    }

    // Width profile: thick in the middle, tapered at head and tail
    float rootW = bw * 1.2;
    float midW = bw * 0.35;
    // Parabolic base width along the full curve
    float ef = 4.0 * (bestT - 0.5) * (bestT - 0.5);
    float w = midW + (rootW - midW) * ef;

    // Head/tail tapering to a point
    float headFade = smoothstep(headPos, headPos - 0.12, bestT);
    float tailFade = smoothstep(tailPos, tailPos + 0.12, bestT);
    w *= headFade * tailFade;

    float sdfDist = minDist - w * min(reach * 1.5, 1.0);
    return vec3(sdfDist, bestT, 0.0);
}

void main() {
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
    float cr = CORNER_R_BASE * u_dpr;
    float bw = BW_BASE * u_dpr;

    if (u_tentCount == 0) discard;

    float bestDist = 1e10;
    vec3 bestColor = vec3(0.0);
    float bestGlow = 0.0;

    for (int ti = 0; ti < ${MAX_TENTACLES}; ti++) {
        if (ti >= u_tentCount) break;
        int base = ti * 8;

        vec2 p0 = u_tent[base + 0].xy;
        vec2 p1 = u_tent[base + 0].zw;
        vec2 p2 = u_tent[base + 1].xy;
        vec2 p3 = u_tent[base + 1].zw;
        float reach   = u_tent[base + 2].x;
        float headPos = u_tent[base + 2].y;
        float tailPos = u_tent[base + 2].z;
        float fuseSrc = u_tent[base + 2].w;
        vec3  cA      = u_tent[base + 3].xyz;
        float fuseDst = u_tent[base + 3].w;
        vec3  cB      = u_tent[base + 4].xyz;
        vec4  boxSrc  = u_tent[base + 5];
        vec4  boxDst  = u_tent[base + 6];

        // Box SDFs
        float dSrc = roundedBoxSDF(px, boxSrc, cr);
        float dDst = roundedBoxSDF(px, boxDst, cr);

        // Tentacle SDF (only in tailPos..headPos range)
        vec3 tsdf = tentacleSDF(px, p0, p1, p2, p3, reach, headPos, tailPos, bw);
        float tDist = tsdf.x;
        float tParam = tsdf.y;

        // Directional fusion: source fuses when fuseSrc > 0, dest fuses when fuseDst > 0
        float kRoot = 18.0 * u_dpr;
        float fusedSrc = safeSmin(dSrc, tDist, kRoot * fuseSrc);
        float fusedDst = safeSmin(dDst, tDist, kRoot * fuseDst);

        // Global composite: fuse the two sides together
        float gSDF = safeSmin(fusedSrc, fusedDst, 14.0 * u_dpr);

        // Wobble
        vec2 refCenter = boxSrc.xy + boxSrc.zw * 0.5;
        float angle = atan(px.y - refCenter.y, px.x - refCenter.x);
        float wobble = sin(angle * 5.0 + u_time * 1.5) * 1.0
                     + sin(angle * 8.0 + u_time * 2.3) * 0.6
                     + sin(angle * 13.0 + u_time * 1.1) * 0.4;
        float hw = bw * 0.5 + wobble;

        float d = abs(gSDF) - hw;

        // Flow particles: 4 bright dots moving along tailPos→headPos
        float dotGlow = 0.0;
        float span = headPos - tailPos;
        if (span > 0.01) {
            for (int di = 0; di < 4; di++) {
                float dotT = tailPos + fract(float(di) * 0.25 + u_time * 0.8) * span;
                vec2 dotPos = bezierAt(p0, p1, p2, p3, dotT);
                float dotDist = length(px - dotPos);
                dotGlow += exp(-dotDist * dotDist / (bw * bw * 6.0)) * 0.4;
            }
        }

        if (d < bestDist) {
            bestDist = d;
            float ct = tParam;
            ct = ct * ct * (3.0 - 2.0 * ct);
            bestColor = mix(cA, cB, ct);
            bestGlow = dotGlow;
        }
    }

    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, bestDist);
    if (val < 0.01 && bestGlow < 0.01) discard;

    float a = val * 0.85 + bestGlow;
    a = min(a, 1.0);
    vec3 col = bestColor + bestGlow * vec3(1.0);
    col = min(col, vec3(1.0));
    o_color = vec4(col * a, a);
}
`

function compile(type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || 'shader error')
  return s
}

const prog = gl.createProgram()!
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
gl.linkProgram(prog)
if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
  throw new Error(gl.getProgramInfoLog(prog) || 'link error')
gl.useProgram(prog)

// Fullscreen quad
const buf = gl.createBuffer()!
gl.bindBuffer(gl.ARRAY_BUFFER, buf)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW)
const aPos = gl.getAttribLocation(prog, 'a_pos')
gl.enableVertexAttribArray(aPos)
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

const uRes = gl.getUniformLocation(prog, 'u_res')!
const uTime = gl.getUniformLocation(prog, 'u_time')!
const uDpr = gl.getUniformLocation(prog, 'u_dpr')!
const uTentCount = gl.getUniformLocation(prog, 'u_tentCount')!
const uTent: WebGLUniformLocation[] = []
for (let i = 0; i < MAX_TENTACLES * 8; i++) {
  uTent.push(gl.getUniformLocation(prog, `u_tent[${i}]`)!)
}

gl.enable(gl.BLEND)
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

// ── Draw ────────────────────────────────────────────────────────────────────

function draw(ts: number): void {
  const time = ts / 1000
  const dpr = window.devicePixelRatio || 1

  const ew = Math.round(window.innerWidth * dpr)
  const eh = Math.round(window.innerHeight * dpr)
  if (canvas.width !== ew || canvas.height !== eh) resize()

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  if (boxes.length < 2 || messages.length === 0) { stopLoop(); return }

  // Scale boxes to physical pixels
  const scaled = boxes.map(b => ({
    ...b,
    x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr,
  }))

  const CR = 12 * dpr
  const now = performance.now() / 1000

  // ── Lifecycle: each message is a directed tentacle (from → to) ──────────
  interface TentacleLifecycle {
    fromIdx: number; toIdx: number
    mt: number            // normalized time 0→1
    headPos: number; tailPos: number
    fuseSrc: number; fuseDst: number
    reach: number
  }

  const lives: TentacleLifecycle[] = []

  for (const msg of messages) {
    const fi = scaled.findIndex(b => b.memberName === msg.from)
    const ti = scaled.findIndex(b => b.memberName === msg.to)
    if (fi < 0 || ti < 0 || fi === ti) continue
    const mt = (now - msg.startTime) / msg.duration
    if (mt < 0 || mt > 1) continue
    if (lives.length >= MAX_TENTACLES) break

    // Compute lifecycle parameters from mt
    let headPos: number, tailPos: number, fuseSrc: number, fuseDst: number

    if (mt < 0.05) {
      // Sprout: head slowly pushes out a tiny bit
      headPos = (mt / 0.05) * 0.1
      tailPos = 0
    } else if (mt < 0.40) {
      // Extend: head reaches from 0.1 to 1.0
      headPos = 0.1 + ((mt - 0.05) / 0.35) * 0.9
      tailPos = 0
    } else if (mt < 0.55) {
      // Contact: head at 1, tail at 0, fusion transitions
      headPos = 1.0
      tailPos = 0
    } else if (mt < 0.80) {
      // Detach: tail chases head (0→1)
      headPos = 1.0
      tailPos = (mt - 0.55) / 0.25
    } else {
      // Absorb: tail catches up past 1.0, tentacle shrinks to nothing
      headPos = 1.0 + (mt - 0.80) / 0.20 * 0.05
      tailPos = 1.0 + (mt - 0.80) / 0.20 * 0.05
    }

    // fuseSrc: 1.0 while t<0.4, then linearly to 0 at t=0.6
    if (mt < 0.40) fuseSrc = 1.0
    else if (mt < 0.60) fuseSrc = 1.0 - (mt - 0.40) / 0.20
    else fuseSrc = 0.0

    // fuseDst: 0 while t<0.35, then linearly to 1 at t=0.55
    if (mt < 0.35) fuseDst = 0.0
    else if (mt < 0.55) fuseDst = (mt - 0.35) / 0.20
    else fuseDst = 1.0

    // reach envelope: smooth bell for overall width modulation
    const reach = Math.pow(Math.sin(mt * Math.PI), 0.65)

    lives.push({ fromIdx: fi, toIdx: ti, mt, headPos, tailPos, fuseSrc, fuseDst, reach })
  }

  // ── Build tentacle geometry ──────────────────────────────────────────────
  const tentacles: TentacleData[] = []
  const tentacleBoxPairs: { src: typeof scaled[0]; dst: typeof scaled[0]; fromIdx: number; toIdx: number }[] = []

  for (const life of lives) {
    const src = scaled[life.fromIdx], dst = scaled[life.toIdx]
    const scx = src.x + src.w / 2, scy = src.y + src.h / 2
    const dcx = dst.x + dst.w / 2, dcy = dst.y + dst.h / 2
    const dx = dcx - scx, dy = dcy - scy
    const len = Math.hypot(dx, dy)
    if (len < 1) continue
    const nx = dx / len, ny = dy / len

    const srcExit = findEdgeExit(scx, scy, nx, ny, src.x, src.y, src.w, src.h, CR, len * 0.5, dpr)
    const dstExit = findEdgeExit(dcx, dcy, -nx, -ny, dst.x, dst.y, dst.w, dst.h, CR, len * 0.5, dpr)

    const p0x = scx + nx * srcExit, p0y = scy + ny * srcExit
    const p3x = dcx - nx * dstExit, p3y = dcy - ny * dstExit

    const gapLen = Math.hypot(p3x - p0x, p3y - p0y)
    if (gapLen < 5 * dpr) continue

    const perpX = -ny, perpY = nx
    const wobbleAmt = gapLen * 0.25
    const o1 = Math.sin(time * 1.7 + life.fromIdx * 2.3 + life.toIdx * 1.1) * wobbleAmt
             + Math.sin(time * 2.9 + life.toIdx * 3.1) * wobbleAmt * 0.4
    const o2 = Math.sin(time * 2.1 + life.toIdx * 1.7 + life.fromIdx * 2.9) * wobbleAmt
             + Math.cos(time * 1.3 + life.fromIdx * 2.7) * wobbleAmt * 0.4

    tentacles.push({
      p0x, p0y,
      p1x: p0x + (p3x - p0x) * 0.33 + perpX * o1,
      p1y: p0y + (p3y - p0y) * 0.33 + perpY * o1,
      p2x: p0x + (p3x - p0x) * 0.67 + perpX * o2,
      p2y: p0y + (p3y - p0y) * 0.67 + perpY * o2,
      p3x, p3y,
      reach: life.reach,
      headPos: life.headPos, tailPos: life.tailPos,
      fuseSrc: life.fuseSrc, fuseDst: life.fuseDst,
      colorA: src.color, colorB: dst.color
    })
    tentacleBoxPairs.push({ src, dst, fromIdx: life.fromIdx, toIdx: life.toIdx })
  }

  if (tentacles.length === 0) { stopLoop(); return }

  // Upload uniforms
  gl.uniform2f(uRes, canvas.width, canvas.height)
  gl.uniform1f(uTime, time)
  gl.uniform1f(uDpr, dpr)
  gl.uniform1i(uTentCount, tentacles.length)

  for (let ti = 0; ti < tentacles.length; ti++) {
    const t = tentacles[ti]
    const base = ti * 8
    const pair = tentacleBoxPairs[ti]

    gl.uniform4f(uTent[base + 0], t.p0x, t.p0y, t.p1x, t.p1y)
    gl.uniform4f(uTent[base + 1], t.p2x, t.p2y, t.p3x, t.p3y)
    gl.uniform4f(uTent[base + 2], t.reach, t.headPos, t.tailPos, t.fuseSrc)
    gl.uniform4f(uTent[base + 3], t.colorA[0] / 255, t.colorA[1] / 255, t.colorA[2] / 255, t.fuseDst)
    gl.uniform4f(uTent[base + 4], t.colorB[0] / 255, t.colorB[1] / 255, t.colorB[2] / 255, 0)
    gl.uniform4f(uTent[base + 5], pair.src.x, pair.src.y, pair.src.w, pair.src.h)
    gl.uniform4f(uTent[base + 6], pair.dst.x, pair.dst.y, pair.dst.w, pair.dst.h)
    gl.uniform4f(uTent[base + 7], 0, 0, 0, 0) // reserved
  }

  gl.drawArrays(gl.TRIANGLES, 0, 6)
  requestAnimationFrame(draw)
}

export {}
