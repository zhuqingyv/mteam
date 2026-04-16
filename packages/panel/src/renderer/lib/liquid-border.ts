/**
 * Liquid Border — Reusable WebGL2 SDF Flowing Border Module
 *
 * Provides animated borders with wobbling/pulsing effect, supporting both single colors
 * and gradient color arrays. The border uses Signed Distance Fields (SDF) for smooth rendering
 * and includes activity-based glow and adaptive frame rate.
 *
 * @example
 * ```ts
 * // Single color border
 * const border = new LiquidBorder(canvas, {
 *   colors: [100, 150, 255],
 *   cornerRadius: 8,
 *   borderWidth: 4,
 * });
 * border.start();
 *
 * // Later, update activity level
 * border.setActivity(0.8);
 *
 * // Clean up
 * border.dispose();
 * ```
 */

export interface LiquidBorderOptions {
  /** Color(s) in RGB format (0-255). Single triplet or array of triplets for gradient */
  colors: [number, number, number] | [number, number, number][];
  /** Corner radius in pixels (default: 8) */
  cornerRadius?: number;
  /** Border width in pixels (default: 4) */
  borderWidth?: number;
  /** Wobble amplitude intensity multiplier (default: 1.0) */
  wobbleIntensity?: number;
  /** Animation speed multiplier (default: 1.0) */
  animationSpeed?: number;
  /** Frame rate when idle (default: 24) */
  idleFPS?: number;
  /** Frame rate when active (default: 60) */
  activeFPS?: number;
  /** Enable glow effect (default: true) */
  glowEnabled?: boolean;
  /** Activity-responsive effects (default: true) */
  activityMode?: boolean;
  /** Margin from canvas edges in pixels (default: 8) */
  margin?: number;
}

/**
 * LiquidBorder class manages WebGL rendering of animated flowing borders.
 */
export class LiquidBorder {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private uniforms: {
    uRes: WebGLUniformLocation;
    uTime: WebGLUniformLocation;
    uColor: WebGLUniformLocation;
    uDpr: WebGLUniformLocation;
    uActivity: WebGLUniformLocation;
    uColorCount?: WebGLUniformLocation;
    uColors?: WebGLUniformLocation;
  };
  private options: Required<LiquidBorderOptions>;
  private animationId: number | null = null;
  private lastFrameTime = 0;
  private isRunning = false;
  private currentActivity = 0;
  private colors: [number, number, number][];

  constructor(canvas: HTMLCanvasElement, options: LiquidBorderOptions) {
    this.canvas = canvas;
    this.options = {
      cornerRadius: options.cornerRadius ?? 8,
      borderWidth: options.borderWidth ?? 4,
      wobbleIntensity: options.wobbleIntensity ?? 1.0,
      animationSpeed: options.animationSpeed ?? 1.0,
      idleFPS: options.idleFPS ?? 24,
      activeFPS: options.activeFPS ?? 60,
      glowEnabled: options.glowEnabled ?? true,
      activityMode: options.activityMode ?? true,
      margin: options.margin ?? 8,
      colors: options.colors,
    };

    // Normalize colors to array of triplets
    this.colors = Array.isArray(options.colors[0])
      ? (options.colors as [number, number, number][])
      : [options.colors as [number, number, number]];

    // Get WebGL context
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Compile shaders
    const shaders = createLiquidBorderShaders(options);
    this.program = this.compileProgram(shaders.vert, shaders.frag);
    this.gl.useProgram(this.program);

    // Setup fullscreen quad
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

    // Get uniform locations
    this.uniforms = {
      uRes: this.gl.getUniformLocation(this.program, 'u_res')!,
      uTime: this.gl.getUniformLocation(this.program, 'u_time')!,
      uColor: this.gl.getUniformLocation(this.program, 'u_color')!,
      uDpr: this.gl.getUniformLocation(this.program, 'u_dpr')!,
      uActivity: this.gl.getUniformLocation(this.program, 'u_activity')!,
    };

    if (this.colors.length > 1) {
      this.uniforms.uColorCount = this.gl.getUniformLocation(this.program, 'u_colorCount');
      this.uniforms.uColors = this.gl.getUniformLocation(this.program, 'u_colors');
    }

    // Setup blend mode
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);

    this.resize();
    window.addEventListener('resize', () => this.resize());
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
   * Set activity level (0.0-1.0) for glow and wobble intensity
   */
  setActivity(level: number): void {
    this.currentActivity = Math.max(0, Math.min(1, level));
  }

  /**
   * Set single color
   */
  setColor(color: [number, number, number]): void {
    this.colors = [color];
  }

  /**
   * Set gradient colors
   */
  setColors(colors: [number, number, number][]): void {
    if (colors.length === 0) throw new Error('colors array must not be empty');
    this.colors = colors;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stop();
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.program) this.gl.deleteProgram(this.program);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  private compileProgram(vert: string, frag: string): WebGLProgram {
    const program = this.gl.createProgram()!;

    const vs = this.gl.createShader(this.gl.VERTEX_SHADER)!;
    this.gl.shaderSource(vs, vert);
    this.gl.compileShader(vs);
    if (!this.gl.getShaderParameter(vs, this.gl.COMPILE_STATUS)) {
      throw new Error('Vertex shader compile error: ' + this.gl.getShaderInfoLog(vs));
    }

    const fs = this.gl.createShader(this.gl.FRAGMENT_SHADER)!;
    this.gl.shaderSource(fs, frag);
    this.gl.compileShader(fs);
    if (!this.gl.getShaderParameter(fs, this.gl.COMPILE_STATUS)) {
      throw new Error('Fragment shader compile error: ' + this.gl.getShaderInfoLog(fs));
    }

    this.gl.attachShader(program, vs);
    this.gl.attachShader(program, fs);
    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + this.gl.getProgramInfoLog(program));
    }

    this.gl.deleteShader(vs);
    this.gl.deleteShader(fs);

    return program;
  }

  private draw = (ts: number = 0): void => {
    if (!this.isRunning) return;

    const dpr = window.devicePixelRatio || 1;
    const frameInterval =
      this.currentActivity > 0.01
        ? (1000 / this.options.activeFPS)
        : (1000 / this.options.idleFPS);

    if (ts - this.lastFrameTime < frameInterval) {
      this.animationId = requestAnimationFrame(this.draw);
      return;
    }

    this.lastFrameTime = ts;

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    this.gl.uniform2f(this.uniforms.uRes, this.canvas.width, this.canvas.height);
    this.gl.uniform1f(this.uniforms.uTime, ts / 1000);
    this.gl.uniform1f(this.uniforms.uDpr, dpr);

    if (this.colors.length === 1) {
      // Single color mode
      const [r, g, b] = this.colors[0];
      this.gl.uniform3f(this.uniforms.uColor, r / 255, g / 255, b / 255);
    } else {
      // Multi-color gradient mode
      if (this.uniforms.uColorCount && this.uniforms.uColors) {
        this.gl.uniform1i(this.uniforms.uColorCount, this.colors.length);
        const flatColors = this.colors.flatMap(([r, g, b]) => [r / 255, g / 255, b / 255]);
        this.gl.uniform3fv(this.uniforms.uColors, new Float32Array(flatColors));
      }
    }

    if (this.options.activityMode) {
      this.gl.uniform1f(this.uniforms.uActivity, this.currentActivity);
    } else {
      this.gl.uniform1f(this.uniforms.uActivity, 0);
    }

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.animationId = requestAnimationFrame(this.draw);
  };
}

/**
 * Create shader source code for liquid border
 */
export function createLiquidBorderShaders(options: LiquidBorderOptions): {
  vert: string;
  frag: string;
} {
  const isMultiColor = Array.isArray(options.colors[0]);
  const cornerRadius = options.cornerRadius ?? 8;
  const borderWidth = options.borderWidth ?? 4;
  const wobbleIntensity = options.wobbleIntensity ?? 1.0;
  const animationSpeed = options.animationSpeed ?? 1.0;
  const margin = options.margin ?? 8;
  const glowEnabled = options.glowEnabled ?? true;

  const vert = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`;

  let frag = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_color;
uniform float u_dpr;
uniform float u_activity;
`;

  if (isMultiColor) {
    frag += `
uniform int u_colorCount;
uniform vec3 u_colors[16];
`;
  }

  frag += `
out vec4 o_color;

const float PI = 3.14159265;

float roundedBoxSDF(vec2 p, vec2 center, vec2 halfSize, float r) {
    vec2 d = abs(p - center) - halfSize + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

${isMultiColor ? `
float arcPos(vec2 p, vec2 center) {
    float a = atan(p.y - center.y, p.x - center.x);
    return fract(a / (2.0 * PI) + 0.5);
}

vec3 sampleGradient(float t, int count) {
    if (count <= 1) return u_colors[0];
    float ft = fract(t) * float(count);
    int i0 = int(ft);
    int i1 = i0 + 1;
    if (i1 >= count) i1 = 0;
    float f = fract(ft);
    f = f * f * (3.0 - 2.0 * f);
    return mix(u_colors[i0], u_colors[i1], f);
}
` : ''}

void main() {
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);

    float margin = ${margin}.0 * u_dpr;
    float cr = ${cornerRadius}.0 * u_dpr;
    float bw = ${borderWidth}.0 * u_dpr;
    float wobbleInt = ${wobbleIntensity};
    float animSpeed = ${animationSpeed};

    vec2 boxCenter = u_res * 0.5;
    vec2 boxHalf = (u_res - margin * 2.0) * 0.5;

    float sdf = roundedBoxSDF(px, boxCenter, boxHalf, cr);

    float angle = atan(px.y - boxCenter.y, px.x - boxCenter.x);
    float speed = 1.0 + u_activity * 2.0;
    float wobble = sin(angle * 5.0 + u_time * 1.5 * speed * animSpeed) * wobbleInt * u_dpr
                 + sin(angle * 8.0 + u_time * 2.3 * speed * animSpeed) * 0.6 * wobbleInt * u_dpr
                 + sin(angle * 13.0 + u_time * 1.1 * speed * animSpeed) * 0.4 * wobbleInt * u_dpr;

    float hw = bw * 0.5 + wobble;
    float d = abs(sdf) - hw;
    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, d);

    ${glowEnabled ? `
    // Glow: exponential decay outside the border band
    float glowWidth = u_activity * 8.0 * u_dpr;
    float glowVal = exp(-max(sdf - hw, 0.0) / max(glowWidth, 0.01)) * u_activity * 0.4;
    val = max(val, glowVal);
    ` : ''}

    if (val < 0.01) discard;

    vec3 col;
    ${isMultiColor ? `
    float ap = arcPos(px, boxCenter);
    float flowSpeed = 0.15;
    float t = fract(ap + u_time * flowSpeed);
    col = sampleGradient(t, u_colorCount);
    ` : `
    col = u_color;
    `}

    float brightness = 1.0 + u_activity * 0.5;
    float a = val * 0.85 * brightness;
    o_color = vec4(col * a, a);
}
`;

  return { vert, frag };
}
