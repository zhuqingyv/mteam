/**
 * Tentacle Renderer — WebGL2 Bezier Curve Tentacle Module
 *
 * Renders animated tentacles between two axis-aligned boxes.
 * `setTentacles` replaces the full list each frame — cheap enough for
 * <=8 tentacles and keeps call sites stateless.
 */

import { VERT_SHADER, FRAG_SHADER } from './tentacle-shaders';

export interface BoxGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TentacleParams {
  fromBox: BoxGeometry;
  toBox: BoxGeometry;
  colorA: [number, number, number];
  colorB: [number, number, number];
  reach?: number;
  headPos?: number;
  tailPos?: number;
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
const FLOATS_PER_TENTACLE = 32;

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
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this.program = this.compileProgram(VERT_SHADER, FRAG_SHADER);
    this.gl.useProgram(this.program);

    this.buffer = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      this.gl.STATIC_DRAW,
    );

    const aPos = this.gl.getAttribLocation(this.program, 'a_pos');
    this.gl.enableVertexAttribArray(aPos);
    this.gl.vertexAttribPointer(aPos, 2, this.gl.FLOAT, false, 0, 0);

    this.uniformBuf = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.uniformBuf);
    this.gl.bufferData(
      this.gl.UNIFORM_BUFFER,
      new Float32Array(MAX_TENTACLES * FLOATS_PER_TENTACLE),
      this.gl.DYNAMIC_DRAW,
    );

    this.uniforms = {
      uRes: this.gl.getUniformLocation(this.program, 'u_res')!,
      uTime: this.gl.getUniformLocation(this.program, 'u_time')!,
      uDpr: this.gl.getUniformLocation(this.program, 'u_dpr')!,
      uTentCount: this.gl.getUniformLocation(this.program, 'u_tentCount')!,
      uTent: this.gl.getUniformLocation(this.program, 'u_tent')!,
    };

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);

    this.resizeHandler = () => this.resize();
    this.resize();
    window.addEventListener('resize', this.resizeHandler);
  }

  /** Resize backing store to match the canvas CSS box. Call on container resize. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  /** Replace the current tentacle set. */
  setTentacles(list: TentacleParams[]): void {
    const trimmed = list.slice(0, MAX_TENTACLES);
    this.tentacles = trimmed.map((p) => this.computeTentacle(p));
    this.updateUniforms();
  }

  clearTentacles(): void {
    this.tentacles = [];
    this.updateUniforms();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.animationId = requestAnimationFrame(this.draw);
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resizeHandler);
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.uniformBuf) this.gl.deleteBuffer(this.uniformBuf);
    if (this.program) this.gl.deleteProgram(this.program);
  }

  private computeTentacle(params: TentacleParams): ComputedTentacle {
    const fromCenter: [number, number] = [
      params.fromBox.x + params.fromBox.w / 2,
      params.fromBox.y + params.fromBox.h / 2,
    ];
    const toCenter: [number, number] = [
      params.toBox.x + params.toBox.w / 2,
      params.toBox.y + params.toBox.h / 2,
    ];

    const dx = toCenter[0] - fromCenter[0];
    const dy = toCenter[1] - fromCenter[1];
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;

    const dpr = window.devicePixelRatio || 1;
    const p0 = findEdgeExit(fromCenter[0], fromCenter[1], nx, ny, params.fromBox, 200, dpr);
    const p3 = findEdgeExit(toCenter[0], toCenter[1], -nx, -ny, params.toBox, 200, dpr);

    const mid: [number, number] = [(fromCenter[0] + toCenter[0]) / 2, (fromCenter[1] + toCenter[1]) / 2];
    const pullDist = dist * 0.3;
    const perp = [-ny, nx];
    const p1: [number, number] = [mid[0] + perp[0] * pullDist, mid[1] + perp[1] * pullDist];
    const p2: [number, number] = [mid[0] - perp[0] * pullDist, mid[1] - perp[1] * pullDist];

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
    const data = new Float32Array(MAX_TENTACLES * FLOATS_PER_TENTACLE);

    for (let i = 0; i < this.tentacles.length; i++) {
      const t = this.tentacles[i];
      const o = i * FLOATS_PER_TENTACLE;
      data[o + 0] = t.p0[0]; data[o + 1] = t.p0[1];
      data[o + 2] = t.p1[0]; data[o + 3] = t.p1[1];
      data[o + 4] = t.p2[0]; data[o + 5] = t.p2[1];
      data[o + 6] = t.p3[0]; data[o + 7] = t.p3[1];
      data[o + 8] = t.reach; data[o + 9] = t.headPos;
      data[o + 10] = t.tailPos; data[o + 11] = t.fuseSrc;
      data[o + 12] = t.colorA[0] / 255;
      data[o + 13] = t.colorA[1] / 255;
      data[o + 14] = t.colorA[2] / 255;
      data[o + 15] = t.fuseDst;
      data[o + 16] = t.colorB[0] / 255;
      data[o + 17] = t.colorB[1] / 255;
      data[o + 18] = t.colorB[2] / 255;
      data[o + 19] = 0;
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
    if (!this.isRunning) return;

    const frameInterval = 1000 / 60;
    if (ts - this.lastFrameTime < frameInterval) {
      this.animationId = requestAnimationFrame(this.draw);
      return;
    }
    this.lastFrameTime = ts;

    const dpr = window.devicePixelRatio || 1;

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    if (this.tentacles.length > 0) {
      this.gl.uniform2f(this.uniforms.uRes, this.canvas.width, this.canvas.height);
      this.gl.uniform1f(this.uniforms.uTime, ts / 1000);
      this.gl.uniform1f(this.uniforms.uDpr, dpr);
      this.gl.uniform1i(this.uniforms.uTentCount, this.tentacles.length);
      this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    this.animationId = requestAnimationFrame(this.draw);
  };
}

/** Walk a ray outward from box center until it exits the rounded box SDF. */
function findEdgeExit(
  cx: number,
  cy: number,
  nx: number,
  ny: number,
  box: BoxGeometry,
  maxDist: number,
  dpr: number,
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
