// 液态玻璃自定义 ShaderMaterial。
//
// 为什么不用 drei MeshTransmissionMaterial：它折射采样的是 scene FBO，
// transparent 窗口里 FBO 全黑 → 玻璃内一片黑。换自定义 shader 直接屏幕
// 空间折射采样我们手头的壁纸纹理。
//
// 关键：无纹理兜底通路。
//   壁纸还没到 / osascript 失败 / HEIC 解不出 / 非 macOS 平台 → uDesktop=null。
//   无兜底就会 texture2D(null) 返回黑 → 玻璃全黑（就是用户看到的"黑色背板"）。
//   兜底做法：uHasDesktop=0 时 gl_FragColor 走纯玻璃路径（法线+菲涅尔渲染
//   冷色渐变 + 边缘高光），完全不依赖纹理。uHasDesktop=1 时走折射采样路径。
//
// 折射 UV 映射：
//   canvasUV = gl_FragCoord.xy / uResolution   // Canvas 像素 0..1
//   deskUV = uWinRect.xy + canvasUV * uWinRect.zw   // 窗口在壁纸上的位置
//   deskUV.y = 1.0 - deskUV.y   // WebGL 左下 vs 图片左上翻转
// X 方向不翻转：窗口向右移动 = 采样点向右移动，方向天然一致。
//
// 色散：R/G/B 分别用略不同偏移采样，边缘出现彩色分离。
// 菲涅尔：法线与视线夹角越大的边缘反射占比越高，模拟真玻璃边缘高光。
// 顶点 shader 保留液态 noise + morph 形变。
import * as THREE from 'three';
import { NOISE_GLSL } from './liquid-noise.glsl';

export type LiquidGlassUniforms = {
  uTime: { value: number };
  uResolution: { value: THREE.Vector2 };
  uDesktop: { value: THREE.Texture | null };
  uHasDesktop: { value: number };
  uWinRect: { value: THREE.Vector4 };
  // cover-fit: 壁纸图片宽高比 / 屏幕逻辑宽高比（shader 用来算裁剪）
  uImgAspect: { value: number };
  uDispAspect: { value: number };
  uLiquidStrength: { value: number };
  uLiquidFreq: { value: number };
  uLiquidSpeed: { value: number };
  uBoxFrom: { value: THREE.Vector3 };
  uBoxTo: { value: THREE.Vector3 };
  uStretchT: { value: number };
  uIor: { value: number };
  uThickness: { value: number };
  uChromatic: { value: number };
  uTint: { value: THREE.Color };
};

const VERT = `
  varying vec3 vNormalView;
  varying vec3 vViewDir;

  uniform float uTime;
  uniform float uLiquidStrength;
  uniform float uLiquidFreq;
  uniform float uLiquidSpeed;
  uniform vec3 uBoxFrom;
  uniform vec3 uBoxTo;
  uniform float uStretchT;

  ${NOISE_GLSL}

  void main() {
    vec3 stretchFactor = mix(vec3(1.0), uBoxTo / uBoxFrom, uStretchT);
    vec3 morphedPos = position * stretchFactor;
    vec3 correctedNormal = normalize(normal / stretchFactor);

    float t = uTime * uLiquidSpeed;
    float n1 = snoise(morphedPos * uLiquidFreq + vec3(t, t*0.7, t*1.3));
    float n2 = snoise(morphedPos * uLiquidFreq * 2.4 + vec3(-t*1.1, t*0.4, -t*0.8));
    float n = n1 * 0.7 + n2 * 0.3;

    vec3 displaced = morphedPos + correctedNormal * n * uLiquidStrength;
    vec3 perturbedNormal = normalize(correctedNormal + correctedNormal * n * uLiquidStrength * 0.6);

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mv;

    vNormalView = normalize(normalMatrix * perturbedNormal);
    vViewDir = normalize(-mv.xyz);
  }
`;

const FRAG = `
  precision highp float;

  varying vec3 vNormalView;
  varying vec3 vViewDir;

  uniform vec2 uResolution;
  uniform sampler2D uDesktop;
  uniform float uHasDesktop;
  uniform vec4 uWinRect;
  uniform float uImgAspect;
  uniform float uDispAspect;
  uniform float uIor;
  uniform float uThickness;
  uniform float uChromatic;
  uniform vec3 uTint;

  // 把 display UV (0..1 相对于整个屏幕) 映射到壁纸纹理 UV，带 cover-fit 裁剪。
  // macOS 桌面用 cover-fit 铺壁纸：保持宽高比，缩放到能完全覆盖屏幕，多出部分居中裁掉。
  // 不做这层变换的话：壁纸直接拉伸到屏幕 → UV 0..1 等于整张图 → 比例错 + 黑边。
  vec2 displayToImageUV(vec2 dispUV) {
    float scaleX = 1.0;
    float scaleY = 1.0;
    if (uImgAspect > uDispAspect) {
      // 壁纸更宽：上下撑满，左右裁
      scaleX = uDispAspect / uImgAspect;
    } else {
      // 壁纸更高：左右撑满，上下裁
      scaleY = uImgAspect / uDispAspect;
    }
    vec2 offset = vec2((1.0 - scaleX) * 0.5, (1.0 - scaleY) * 0.5);
    return offset + vec2(scaleX, scaleY) * dispUV;
  }

  // Canvas UV + 折射偏移 → 窗口所在 display 位置 → 壁纸纹理 UV。
  //
  // Y 翻转的正确姿势（之前错的点）：
  //   uWinRect.y 是屏幕坐标系（0=顶）下的归一化窗口 Y；但 canvasUV.y 在 WebGL
  //   里 0=底。所以要先把 canvasUV.y 从 WebGL 坐标翻到屏幕坐标，再跟 uWinRect
  //   相加。等价于 Y 分量用 (1 - canvasUV.y) 做线性插值。
  //   错误写法（之前的实现）是先算 dispUV 再整体 1-dispUV.y，只在窗口满铺
  //   屏幕时巧合正确，其他位置会错位 (1 - 2*winY - winH)。这就是"位置偏"根因。
  //   X 方向 canvasUV.x 0=左 跟 uWinRect.x 0=左方向一致，直接线性映射即可。
  vec2 toDesktopUV(vec2 canvasUV, vec2 offset) {
    vec2 uv = clamp(canvasUV + offset, vec2(0.0), vec2(1.0));
    vec2 dispUV = vec2(
      uWinRect.x + uv.x * uWinRect.z,
      uWinRect.y + (1.0 - uv.y) * uWinRect.w
    );
    return displayToImageUV(dispUV);
  }

  // 无纹理兜底：纯玻璃感。法线向上分量做冷色→暖色渐变，菲涅尔加边缘白光。
  // 目标是让用户第一眼不是黑屏，看着像一块未着色的透明玻璃。
  vec3 pureGlass(vec3 n, vec3 v) {
    // 法线的 z 分量（朝向相机的程度）映射到一个淡蓝淡紫的渐变
    float facing = max(dot(n, v), 0.0);
    vec3 coolTop = vec3(0.72, 0.78, 0.92);   // 淡蓝紫
    vec3 warmCore = vec3(0.92, 0.88, 0.98);  // 微暖近白
    vec3 base = mix(coolTop, warmCore, facing);
    // 法线的 y 分量给上下一点明暗变化，让体积感出来
    base += vec3(0.05, 0.03, 0.06) * n.y;
    return base;
  }

  void main() {
    vec2 canvasUV = gl_FragCoord.xy / uResolution;
    vec3 n = normalize(vNormalView);
    vec3 v = normalize(vViewDir);

    float refractScale = uThickness * (1.0 - 1.0 / uIor);
    vec2 baseOffset = -n.xy * refractScale;

    vec3 refracted;
    if (uHasDesktop > 0.5) {
      float rScale = 1.0 + uChromatic;
      float gScale = 1.0;
      float bScale = 1.0 - uChromatic;
      vec4 cR = texture2D(uDesktop, toDesktopUV(canvasUV, baseOffset * rScale));
      vec4 cG = texture2D(uDesktop, toDesktopUV(canvasUV, baseOffset * gScale));
      vec4 cB = texture2D(uDesktop, toDesktopUV(canvasUV, baseOffset * bScale));
      refracted = vec3(cR.r, cG.g, cB.b) * uTint;
    } else {
      refracted = pureGlass(n, v) * uTint;
    }

    float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 edgeHighlight = mix(refracted, vec3(1.0), fresnel * 0.35);

    gl_FragColor = vec4(edgeHighlight, 1.0);
  }
`;

export function createLiquidGlassMaterial(): THREE.ShaderMaterial {
  const uniforms: LiquidGlassUniforms = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDesktop: { value: null },
    uHasDesktop: { value: 0 },
    uWinRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uImgAspect: { value: 1 },
    uDispAspect: { value: 1 },
    uLiquidStrength: { value: 0.1 },
    uLiquidFreq: { value: 1.8 },
    uLiquidSpeed: { value: 0.55 },
    uBoxFrom: { value: new THREE.Vector3(3.0, 1.5, 0.4) },
    uBoxTo: { value: new THREE.Vector3(6.0, 4.0, 0.3) },
    uStretchT: { value: 0 },
    uIor: { value: 1.5 },
    uThickness: { value: 0.4 },
    uChromatic: { value: 0.06 },
    uTint: { value: new THREE.Color('#ffffff') },
  };

  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: false,
    side: THREE.FrontSide,
  });
}
