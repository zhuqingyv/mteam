// ── WebGL2 Liquid SDF Border for Panel Window ─────────────────────────────────
// Multi-member color gradient flowing around the border like a marquee.
// Uses same SDF + wobble as terminal-border.ts, but color is a gradient of all
// online member colors interpolated by arc-length position + time offset.

const canvas = document.getElementById('border-canvas') as HTMLCanvasElement
if (!canvas) throw new Error('border-canvas not found')

const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })!
if (!gl) throw new Error('WebGL2 not supported')

// ── Color palette (same as terminal-window.ts / Avatar.tsx) ──────────────────
const PALETTE_HEX = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#2563eb',
]
const PALETTE_RGB: number[][] = PALETTE_HEX.map(hex => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
])

function uidToColorRgb(uid: string): number[] {
  let hash = 0
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0
  }
  return PALETTE_RGB[Math.abs(hash) % PALETTE_RGB.length]
}

// ── Member colors ────────────────────────────────────────────────────────────
const MAX_COLORS = 16
// Default: single accent color
let memberColors: number[][] = [[99, 102, 241]] // indigo-500

async function loadMemberColors(): Promise<void> {
  try {
    const status = await (window as any).teamHub.getInitialStatus()
    updateColorsFromStatus(status)
  } catch { /* use default */ }
}

function updateColorsFromStatus(status: any): void {
  if (!status?.members?.length) return
  const colors: number[][] = []
  for (const m of status.members) {
    if (m.uid && colors.length < MAX_COLORS) {
      colors.push(uidToColorRgb(m.uid))
    }
  }
  if (colors.length > 0) {
    memberColors = colors
    uploadColors()
  }
}

// Listen for status updates
if ((window as any).teamHub?.onStatusUpdate) {
  (window as any).teamHub.onStatusUpdate(updateColorsFromStatus)
}

// ── Resize ───────────────────────────────────────────────────────────────────
function resize(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  gl.viewport(0, 0, canvas.width, canvas.height)
}
resize()
window.addEventListener('resize', resize)

// ── Shaders ──────────────────────────────────────────────────────────────────
const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform int u_colorCount;
uniform vec3 u_colors[${MAX_COLORS}];
out vec4 o_color;

const float PI = 3.14159265;

float roundedBoxSDF(vec2 p, vec2 center, vec2 halfSize, float r) {
    vec2 d = abs(p - center) - halfSize + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// Approximate arc-length position around the rounded rect [0,1)
// Uses atan2 angle mapped to perimeter fraction
float arcPos(vec2 p, vec2 center) {
    float a = atan(p.y - center.y, p.x - center.x); // [-PI, PI]
    return fract(a / (2.0 * PI) + 0.5); // [0, 1)
}

// Smooth interpolation through the color array at position t [0,1)
vec3 sampleGradient(float t, int count) {
    if (count <= 1) return u_colors[0];
    float ft = fract(t) * float(count);
    int i0 = int(ft);
    int i1 = i0 + 1;
    if (i1 >= count) i1 = 0;
    float f = fract(ft);
    // Smoothstep for smoother transitions
    f = f * f * (3.0 - 2.0 * f);
    return mix(u_colors[i0], u_colors[i1], f);
}

void main() {
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);

    float margin = 8.0 * u_dpr;
    float cr = 8.0 * u_dpr;
    float bw = 4.0 * u_dpr;

    vec2 boxCenter = u_res * 0.5;
    vec2 boxHalf = (u_res - margin * 2.0) * 0.5;

    float sdf = roundedBoxSDF(px, boxCenter, boxHalf, cr);

    float angle = atan(px.y - boxCenter.y, px.x - boxCenter.x);
    float wobble = sin(angle * 5.0 + u_time * 1.5) * 1.0 * u_dpr
                 + sin(angle * 8.0 + u_time * 2.3) * 0.6 * u_dpr
                 + sin(angle * 13.0 + u_time * 1.1) * 0.4 * u_dpr;

    float hw = bw * 0.5 + wobble;
    float d = abs(sdf) - hw;
    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, d);

    if (val < 0.01) discard;

    // Color: flowing gradient of all member colors
    // arcPos gives position around the border, offset by time for marquee
    float ap = arcPos(px, boxCenter);
    float flowSpeed = 0.15; // full loop per ~6.7 seconds
    float t = fract(ap + u_time * flowSpeed);
    vec3 col = sampleGradient(t, u_colorCount);

    float a = val * 0.85;
    o_color = vec4(col * a, a);
}
`

function compile(type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile error')
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

// Uniforms
const uRes = gl.getUniformLocation(prog, 'u_res')!
const uTime = gl.getUniformLocation(prog, 'u_time')!
const uDpr = gl.getUniformLocation(prog, 'u_dpr')!
const uColorCount = gl.getUniformLocation(prog, 'u_colorCount')!
const uColors: WebGLUniformLocation[] = []
for (let i = 0; i < MAX_COLORS; i++) {
  uColors.push(gl.getUniformLocation(prog, `u_colors[${i}]`)!)
}

gl.enable(gl.BLEND)
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

function uploadColors(): void {
  gl.useProgram(prog)
  gl.uniform1i(uColorCount, memberColors.length)
  for (let i = 0; i < MAX_COLORS; i++) {
    if (i < memberColors.length) {
      const c = memberColors[i]
      gl.uniform3f(uColors[i], c[0] / 255, c[1] / 255, c[2] / 255)
    } else {
      gl.uniform3f(uColors[i], 0, 0, 0)
    }
  }
}

// ── Draw loop (24fps — slow wobble, no need for 60) ──────────────────────────
const FRAME_INTERVAL = 1000 / 24
let lastFrame = 0

function draw(ts: number): void {
  requestAnimationFrame(draw)
  if (ts - lastFrame < FRAME_INTERVAL) return
  lastFrame = ts

  const dpr = window.devicePixelRatio || 1
  const ew = Math.round(window.innerWidth * dpr)
  const eh = Math.round(window.innerHeight * dpr)
  if (canvas.width !== ew || canvas.height !== eh) resize()

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.uniform2f(uRes, canvas.width, canvas.height)
  gl.uniform1f(uTime, ts / 1000)
  gl.uniform1f(uDpr, dpr)

  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

// Initial upload + start
loadMemberColors().then(() => {
  uploadColors()
  requestAnimationFrame(draw)
})

export {}
