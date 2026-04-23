// ── WebGL2 Liquid SDF Border for Terminal Windows ────────────────────────────

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

const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })!
if (!gl) throw new Error('WebGL2 not supported')

let memberColor: [number, number, number] = [100, 180, 255]

async function loadColor(): Promise<void> {
  if (window.terminalBridge?.getMemberColor) {
    try {
      const color = await window.terminalBridge.getMemberColor()
      if (Array.isArray(color) && color.length === 3) {
        memberColor = color as [number, number, number]
        return
      }
    } catch { /* fall through */ }
  }
  const params = new URLSearchParams(window.location.search)
  const colorParam = params.get('color')
  if (colorParam) {
    const parts = colorParam.split(',').map(Number)
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      memberColor = parts as [number, number, number]
    }
  }
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  gl.viewport(0, 0, canvas.width, canvas.height)
}
resize()
window.addEventListener('resize', resize)

// ── Shaders ─────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_color;
uniform float u_dpr;
uniform float u_activity;
out vec4 o_color;

float roundedBoxSDF(vec2 p, vec2 center, vec2 halfSize, float r) {
    vec2 d = abs(p - center) - halfSize + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
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
    // Wobble frequency scales with activity: 1x at idle, 3x at full activity
    float speed = 1.0 + u_activity * 2.0;
    float wobble = sin(angle * 5.0 + u_time * 1.5 * speed) * 1.0 * u_dpr
                 + sin(angle * 8.0 + u_time * 2.3 * speed) * 0.6 * u_dpr
                 + sin(angle * 13.0 + u_time * 1.1 * speed) * 0.4 * u_dpr;

    float hw = bw * 0.5 + wobble;
    float d = abs(sdf) - hw;
    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, d);

    // Glow: exponential decay outside the border band, proportional to activity
    float glowWidth = u_activity * 8.0 * u_dpr;
    float glowVal = exp(-max(sdf - hw, 0.0) / max(glowWidth, 0.01)) * u_activity * 0.4;
    val = max(val, glowVal);

    if (val < 0.01) discard;

    // Brightness: 1.0 at idle (matches current), up to 1.5 at full activity
    float brightness = 1.0 + u_activity * 0.5;
    float a = val * 0.85 * brightness;
    o_color = vec4(u_color * a, a);
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
const uColor = gl.getUniformLocation(prog, 'u_color')!
const uDpr = gl.getUniformLocation(prog, 'u_dpr')!
const uActivity = gl.getUniformLocation(prog, 'u_activity')!

gl.enable(gl.BLEND)
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

const FRAME_INTERVAL_IDLE = 1000 / 24   // 24fps when idle
const FRAME_INTERVAL_ACTIVE = 1000 / 60 // 60fps when thinking
let lastFrame = 0

function draw(ts: number): void {
  requestAnimationFrame(draw)
  const activity: number = (window as any).__borderActivity || 0
  // Adaptive frame rate: 60fps when active, 24fps when idle
  const frameInterval = activity > 0.01 ? FRAME_INTERVAL_ACTIVE : FRAME_INTERVAL_IDLE
  if (ts - lastFrame < frameInterval) return
  lastFrame = ts

  const dpr = window.devicePixelRatio || 1
  const ew = Math.round(window.innerWidth * dpr)
  const eh = Math.round(window.innerHeight * dpr)
  if (canvas.width !== ew || canvas.height !== eh) resize()

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.uniform2f(uRes, canvas.width, canvas.height)
  gl.uniform1f(uTime, ts / 1000)
  gl.uniform3f(uColor, memberColor[0] / 255, memberColor[1] / 255, memberColor[2] / 255)
  gl.uniform1f(uDpr, dpr)
  gl.uniform1f(uActivity, activity)

  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

loadColor().then(() => requestAnimationFrame(draw))

export {}
