/**
 * Tentacle Renderer — Reusable WebGL2 Bezier Curve Tentacle Module
 *
 * Renders animated tentacles between two points using cubic Bezier curves.
 * Supports color interpolation and dynamic geometry updates.
 *
 * @example
 * ```ts
 * const renderer = new TentacleRenderer(canvas);
 * renderer.addTentacle({
 *   fromBox: { x: 100, y: 100, w: 200, h: 150 },
 *   toBox: { x: 400, y: 400, w: 200, h: 150 },
 *   colorA: [255, 100, 100],
 *   colorB: [100, 100, 255],
 * });
 * renderer.start();
 * ```
 */

export interface BoxGeometry {
  /** X coordinate of box top-left */
  x: number;
  /** Y coordinate of box top-left */
  y: number;
  /** Box width */
  w: number;
  /** Box height */
  h: number;
}

export interface TentacleParams {
  /** Source box */
  fromBox: BoxGeometry;
  /** Destination box */
  toBox: BoxGeometry;
  /** Color at source (RGB 0-255) */
  colorA: [number, number, number];
  /** Color at destination (RGB 0-255) */
  colorB: [number, number, number];
  /** Reach/width of tentacle (default: 1.0, range 0.1-2.0) */
  reach?: number;
  /** Head position along curve [0,1] (default: 1.0) */
  headPos?: number;
  /** Tail position along curve [0,1] (default: 0.0) */
  tailPos?: number;
  /** Animation state (0.0-1.0) (default: 1.0) */
  fuse?: number;
}

interface ComputedTentacle {
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
  reach: number;
  headPos: number;
  tailPos: number;
  fuseSrc: number;
  fuseDst: number;
  colorA: [number, number, number];
  colorB: [number, number, number];
}

const MAX_TENTACLES = 8;

/**
 * TentacleRenderer manages WebGL rendering of Bezier tentacles
 */
export class TentacleRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private uniformBuf: WebGLBuffer;
  private uniforms: {
    uRes: WebGLUniformLocation;
    uTime: WebGLUniformLocation;
    uDpr: WebGLUniformLocation;
    uTentCount: WebGLUniformLocation;
    uTent: WebGLUniformLocation;
  };
  private tentacles: ComputedTentacle[] = [];
  private animationId: number | null = null;
  private isRunning = false;
  private lastFrameTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Compile program
    this.program = this.compileProgram(VERT_SHADER, FRAG_SHADER);
    this.gl.useProgram(this.program);

    // Fullscreen quad
    this.buffer = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      this.gl.STATIC_DRAW
    );

    const aPos = this.gl.getAttribLocation(this.program, 'a_pos');
    this.gl.enableVertexAttribArray(aPos);
    this.gl.vertexAttribPointer(aPos, 2, this.gl.FLOAT, false, 0, 0);

    // Uniform buffer for tentacle data
    this.uniformBuf = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.uniformBuf);
    this.gl.bufferData(this.gl.UNIFORM_BUFFER, new Float32Array(MAX_TENTACLES * 32), this.gl.DYNAMIC_DRAW);

    // Get uniform locations
    this.uniforms = {
      uRes: this.gl.getUniformLocation(this.program, 'u_res')!,
      uTime: this.gl.getUniformLocation(this.program, 'u_time')!,
      uDpr: this.gl.getUniformLocation(this.program, 'u_dpr')!,
      uTentCount: this.gl.getUniformLocation(this.program, 'u_tentCount')!,
      uTent: this.gl.getUniformLocation(this.program, `u_tent`)!,
    };

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Add a tentacle to render
   */
  addTentacle(params: TentacleParams): void {
    if (this.tentacles.length >= MAX_TENTACLES) {
      console.warn(`Max tentacles (${MAX_TENTACLES}) reached`);
      return;
    }

    const tentacle = this.computeTentacle(params);
    this.tentacles.push(tentacle);
    this.updateUniforms();
  }

  /**
   * Clear all tentacles
   */
  clearTentacles(): void {
    this.tentacles = [];
  }

  /**
   * Start rendering
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.draw();
  }

  /**
   * Stop rendering
   */
  stop(): void {
    this.isRunning = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stop();
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.uniformBuf) this.gl.deleteBuffer(this.uniformBuf);
    if (this.program) this.gl.deleteProgram(this.program);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.gl.viewport(0, 0, w, h);
  }

  private computeTentacle(params: TentacleParams): ComputedTentacle {
    // Find edge exit points
    const fromCenter = [params.fromBox.x + params.fromBox.w / 2, params.fromBox.y + params.fromBox.h / 2] as const;
    const toCenter = [params.toBox.x + params.toBox.w / 2, params.toBox.y + params.toBox.h / 2] as const;

    const dx = toCenter[0] - fromCenter[0];
    const dy = toCenter[1] - fromCenter[1];
    const dist = Math.hypot(dx, dy);
    const nx = dx / dist;
    const ny = dy / dist;

    const dpr = window.devicePixelRatio || 1;
    const p0 = findEdgeExit(fromCenter[0], fromCenter[1], nx, ny, params.fromBox, 200, dpr);
    const p3 = findEdgeExit(toCenter[0], toCenter[1], -nx, -ny, params.toBox, 200, dpr);

    // Control points: pull inward toward center
    const mid = [(fromCenter[0] + toCenter[0]) / 2, (fromCenter[1] + toCenter[1]) / 2] as const;
    const pullDist = dist * 0.3;
    const perp = [-ny, nx];
    const p1 = [mid[0] + perp[0] * pullDist, mid[1] + perp[1] * pullDist] as const;
    const p2 = [mid[0] - perp[0] * pullDist, mid[1] - perp[1] * pullDist] as const;

    return {
      p0,
      p1,
      p2,
      p3,
      reach: params.reach ?? 1.0,
      headPos: params.headPos ?? 1.0,
      tailPos: params.tailPos ?? 0.0,
      fuseSrc: params.fuse ?? 1.0,
      fuseDst: params.fuse ?? 1.0,
      colorA: params.colorA,
      colorB: params.colorB,
    };
  }

  private updateUniforms(): void {
    const data = new Float32Array(MAX_TENTACLES * 32);

    for (let i = 0; i < this.tentacles.length; i++) {
      const t = this.tentacles[i];
      const offset = i * 32;

      // Layout: 8 float4 per tentacle (32 floats)
      data[offset + 0] = t.p0[0];
      data[offset + 1] = t.p0[1];
      data[offset + 2] = t.p1[0];
      data[offset + 3] = t.p1[1];

      data[offset + 4] = t.p2[0];
      data[offset + 5] = t.p2[1];
      data[offset + 6] = t.p3[0];
      data[offset + 7] = t.p3[1];

      data[offset + 8] = t.reach;
      data[offset + 9] = t.headPos;
      data[offset + 10] = t.tailPos;
      data[offset + 11] = t.fuseSrc;

      data[offset + 12] = t.colorA[0] / 255;
      data[offset + 13] = t.colorA[1] / 255;
      data[offset + 14] = t.colorA[2] / 255;
      data[offset + 15] = t.fuseDst;

      data[offset + 16] = t.colorB[0] / 255;
      data[offset + 17] = t.colorB[1] / 255;
      data[offset + 18] = t.colorB[2] / 255;
      data[offset + 19] = 0;

      // Boxes (srcBox, dstBox) — not used in current shader but reserved
      data[offset + 20] = 0;
      data[offset + 21] = 0;
      data[offset + 22] = 0;
      data[offset + 23] = 0;

      data[offset + 24] = 0;
      data[offset + 25] = 0;
      data[offset + 26] = 0;
      data[offset + 27] = 0;

      data[offset + 28] = 0;
      data[offset + 29] = 0;
      data[offset + 30] = 0;
      data[offset + 31] = 0;
    }

    this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.uniformBuf);
    this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, data);
  }

  private compileProgram(vert: string, frag: string): WebGLProgram {
    const program = this.gl.createProgram()!;

    const vs = this.gl.createShader(this.gl.VERTEX_SHADER)!;
    this.gl.shaderSource(vs, vert);
    this.gl.compileShader(vs);
    if (!this.gl.getShaderParameter(vs, this.gl.COMPILE_STATUS)) {
      throw new Error('Vertex shader: ' + this.gl.getShaderInfoLog(vs));
    }

    const fs = this.gl.createShader(this.gl.FRAGMENT_SHADER)!;
    this.gl.shaderSource(fs, frag);
    this.gl.compileShader(fs);
    if (!this.gl.getShaderParameter(fs, this.gl.COMPILE_STATUS)) {
      throw new Error('Fragment shader: ' + this.gl.getShaderInfoLog(fs));
    }

    this.gl.attachShader(program, vs);
    this.gl.attachShader(program, fs);
    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      throw new Error('Link: ' + this.gl.getProgramInfoLog(program));
    }

    this.gl.deleteShader(vs);
    this.gl.deleteShader(fs);
    return program;
  }

  private draw = (ts: number = 0): void => {
    if (!this.isRunning || this.tentacles.length === 0) {
      this.animationId = requestAnimationFrame(this.draw);
      return;
    }

    const frameInterval = 1000 / 60; // 60fps
    if (ts - this.lastFrameTime < frameInterval) {
      this.animationId = requestAnimationFrame(this.draw);
      return;
    }

    this.lastFrameTime = ts;

    const dpr = window.devicePixelRatio || 1;

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    this.gl.uniform2f(this.uniforms.uRes, this.canvas.width, this.canvas.height);
    this.gl.uniform1f(this.uniforms.uTime, ts / 1000);
    this.gl.uniform1f(this.uniforms.uDpr, dpr);
    this.gl.uniform1i(this.uniforms.uTentCount, this.tentacles.length);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.animationId = requestAnimationFrame(this.draw);
  };
}

/**
 * Find where ray exits from box edge (CPU side)
 */
function findEdgeExit(
  cx: number,
  cy: number,
  nx: number,
  ny: number,
  box: BoxGeometry,
  maxDist: number,
  dpr: number
): [number, number] {
  const CORNER_R = 12 * dpr;
  const step = 2 * dpr;

  for (let s = 0; s < maxDist; s += step) {
    const px = cx + nx * s;
    const py = cy + ny * s;

    const dx = Math.abs(px - (box.x + box.w / 2)) - box.w / 2 + CORNER_R;
    const dy = Math.abs(py - (box.y + box.h / 2)) - box.h / 2 + CORNER_R;
    const sdf =
      Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) +
      Math.min(Math.max(dx, dy), 0) -
      CORNER_R;

    if (sdf > 0) return [px, py];
  }

  return [cx + nx * (maxDist * 0.5), cy + ny * (maxDist * 0.5)];
}

// Shaders
const VERT_SHADER = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`;

const FRAG_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform int u_tentCount;
uniform vec4 u_tent[64];

out vec4 o_color;

const float CORNER_R_BASE = 12.0;
const float BW_BASE = 4.0;
const int BEZIER_SAMPLES = 12;

float roundedBoxSDF(vec2 p, vec4 box, float cr) {
    vec2 center = box.xy + box.zw * 0.5;
    vec2 d = abs(p - center) - box.zw * 0.5 + cr;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - cr;
}

vec2 bezierAt(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float it = 1.0 - t;
    return it*it*it*p0 + 3.0*it*it*t*p1 + 3.0*it*t*t*p2 + t*t*t*p3;
}

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

    float rootW = bw * 1.2;
    float midW = bw * 0.35;
    float ef = 4.0 * (bestT - 0.5) * (bestT - 0.5);
    float w = midW + (rootW - midW) * ef;

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

    for (int ti = 0; ti < 8; ti++) {
        if (ti >= u_tentCount) break;
        int base = ti * 8;

        vec2 p0 = u_tent[base + 0].xy;
        vec2 p1 = u_tent[base + 0].zw;
        vec2 p2 = u_tent[base + 1].xy;
        vec2 p3 = u_tent[base + 1].zw;
        float reach = u_tent[base + 2].x;
        float headPos = u_tent[base + 2].y;
        float tailPos = u_tent[base + 2].z;
        float fuseSrc = u_tent[base + 2].w;
        vec3 cA = u_tent[base + 3].xyz;
        float fuseDst = u_tent[base + 3].w;
        vec3 cB = u_tent[base + 4].xyz;

        vec3 res = tentacleSDF(px, p0, p1, p2, p3, reach, headPos, tailPos, bw);
        float d = res.x;

        if (d < bestDist) {
            bestDist = d;
            float t = res.y;
            bestColor = mix(cA, cB, smoothstep(0.0, 1.0, t));
        }
    }

    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, bestDist);
    if (val < 0.01) discard;

    o_color = vec4(bestColor * val, val);
}
`;
