# WebGL 立体玻璃质感调研

> 目标：实现设计图中"悬浮桌面的 3D 玻璃卡片"效果 —— 立体感、边缘折射、半透明、光斑粒子、缩放动画。
> 与 `electron-glass-research.md`（系统级 vibrancy）互补，本文聚焦 WebGL 渲染层。

---

## 1. 方案对比总览

| 方案 | 效果上限 | 性能开销 | 开发成本 | 适合场景 |
|------|---------|---------|---------|---------|
| **A. Three.js MeshPhysicalMaterial** | 真实 PBR 玻璃，折射/色散/IOR 全支持 | 中高（额外 render pass） | 中（需搭建 3D 场景） | 需要真 3D 立体块 |
| **B. R3F + drei MeshTransmissionMaterial** | A 的增强版，色差/各向异性模糊/层叠透射 | 中高（同 A + React 开销） | **低**（React 声明式，项目已用 React） | **推荐方案** |
| **C. liquidGL** | 极好的 2D 玻璃折射，bevel/frost/specular | 低（轻量 WebGL） | 极低（几行配置） | 不需要 3D 立体，只要"平面玻璃卡片" |
| **D. @ybouane/liquidglass** | 折射+色差+Fresnel+多光源+层叠 | 低中（每 glass 一个 WebGL context） | 低（npm 包 + data 属性配置） | 同 C，更强的光学模拟 |
| **E. electron-liquid-glass** | 原生 NSGlassEffectView，最真实 | 极低（OS 原生渲染） | 极低 | macOS 26+ 专属，不跨平台 |
| **F. PixiJS + filters** | 中等（2D blur/displacement） | 低 | 中 | 2D 游戏 UI |
| **G. 纯 CSS glassmorphism** | 低（扁平毛玻璃，无立体感） | 极低 | 极低 | 快速 MVP |

---

## 2. 方案 A：Three.js MeshPhysicalMaterial

### 核心属性

```js
const glassMaterial = new THREE.MeshPhysicalMaterial({
  transmission: 1.0,          // 完全透光
  roughness: 0.05,            // 接近光滑（0=镜面，1=完全漫反射）
  ior: 1.5,                   // 折射率（玻璃典型值 1.5，钻石 2.4）
  thickness: 2.0,             // 模拟玻璃厚度，影响折射弯曲程度
  specularIntensity: 1.0,     // 高光强度
  clearcoat: 0.1,             // 清漆层（薄反射涂层）
  clearcoatRoughness: 0.1,
  attenuationColor: new THREE.Color('#ffffff'),
  attenuationDistance: 1.0,   // 光衰减距离（模拟有色玻璃）
  envMapIntensity: 1.0,       // 环境贴图强度
  metalness: 0.0,             // 非金属
});
```

### 毛玻璃变体

```js
const frostedGlass = new THREE.MeshPhysicalMaterial({
  transmission: 0.95,
  roughness: 0.4,       // 关键：提高 roughness 产生磨砂效果
  ior: 1.5,
  thickness: 1.5,
});
```

### 效果能力

- 真实折射：通过 transmission + ior 实现光线弯曲
- 色散（dispersion）：Three.js r163+ 支持，TSL 节点 `dispersion`
- 色衰减：attenuationColor/Distance 做有色玻璃
- Fresnel 反射：内置物理 Fresnel，边缘角度越大反射越强

### 性能

- transmission 材质会触发**额外一次完整 render pass**（渲染场景到 transmission texture）
- 单个玻璃对象：60fps 无压力（Electron 内 GPU 加速）
- 多个互相透视的玻璃块：性能急剧下降
- 建议：场景中最多 1-2 个 transmission 物体

### 官方 demo

- https://threejs.org/examples/webgl_materials_physical_transmission.html
- https://threejs.org/examples/#webgl_materials_physical_clearcoat

---

## 3. 方案 B：R3F + drei MeshTransmissionMaterial（推荐）

### 为什么推荐

1. **项目已用 React 19** — R3F v9 直接对应 React 19
2. **声明式 3D** — 不需要手动管理 scene/camera/renderer/resize/dispose
3. **MeshTransmissionMaterial 是 MeshPhysicalMaterial 的增强版** — 额外支持色差、各向异性模糊、噪声粗糙度
4. **生态成熟** — drei 897 releases，社区活跃

### 安装

```bash
bun add three @react-three/fiber @react-three/drei
bun add -d @types/three
```

### 关键代码：玻璃卡片

```tsx
import { Canvas } from '@react-three/fiber'
import { MeshTransmissionMaterial, Environment, Float } from '@react-three/drei'

function GlassCard() {
  return (
    <Float speed={2} rotationIntensity={0.2} floatIntensity={0.5}>
      <mesh>
        {/* 圆角矩形用 RoundedBox（drei 内置） */}
        <roundedBoxGeometry args={[3, 2, 0.15, 4, 0.2]} />
        <MeshTransmissionMaterial
          transmission={1}
          roughness={0.1}
          thickness={0.5}
          chromaticAberration={0.03}  // 色差（边缘彩虹纹）
          anisotropicBlur={0.1}       // 各向异性模糊
          distortion={0}
          temporalDistortion={0}
          ior={1.5}
          color="#ffffff"
          samples={6}                 // 采样数（越高越精确，越慢）
          resolution={512}            // 内部 FBO 分辨率
          backside={false}
        />
      </mesh>
    </Float>
  )
}

function App() {
  return (
    <Canvas
      camera={{ position: [0, 0, 5], fov: 45 }}
      style={{ background: 'transparent' }}
      gl={{ alpha: true }}   // 透明背景，透出 Electron 桌面
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <Environment preset="city" />
      <GlassCard />
    </Canvas>
  )
}
```

### drei 玻璃相关组件

| 组件 | 用途 |
|------|------|
| `MeshTransmissionMaterial` | 高级玻璃/冰/水材质，支持色差+各向异性 |
| `MeshRefractionMaterial` | 钻石级折射，需要 envMap，ray-cast bounces |
| `MeshReflectorMaterial` | 反射平面（地板镜面） |
| `Float` | 悬浮动画（上下浮动+微旋转） |
| `RoundedBox` | 圆角长方体几何体 |
| `Environment` | HDR 环境贴图（一行代码加载预设） |
| `Sparkles` | 粒子/光斑效果（正好对应设计图的散落光斑） |
| `ContactShadows` | 接触阴影（不需要光源，直接投影） |

### 粒子/光斑

```tsx
import { Sparkles } from '@react-three/drei'

<Sparkles
  count={50}
  scale={[4, 3, 1]}
  size={2}
  speed={0.3}
  opacity={0.5}
  color="#c4b5fd"    // 淡紫色光斑
/>
```

### 性能优化

```tsx
<MeshTransmissionMaterial
  samples={4}           // 降低采样（默认 6）
  resolution={256}      // 降低 FBO 分辨率（甚至 64 + roughness 也可接受）
  transmissionSampler   // 多个玻璃物体共享 buffer，避免多次 render pass
/>
```

### 桌面背景透传

Electron 窗口 `transparent: true` + Canvas `gl={{ alpha: true }}` → WebGL 背景透明 → 桌面壁纸可见。但 Three.js 的 transmission 需要场景内容来折射。方案：

1. 用 Electron `desktopCapturer` 截取桌面，作为 texture 贴到玻璃后面的平面上
2. 或者用 `Environment` 贴图模拟环境光照，不直接折射桌面
3. 实际效果：玻璃的折射/反射来自 environment map，背景透过 alpha 通道看到桌面

---

## 4. 方案 C：liquidGL（轻量 2D 玻璃）

### 概述

- GitHub: https://github.com/naughtyduk/liquidGL（456 stars）
- 原理：html2canvas 截取 DOM → WebGL shader 实时折射
- 不是 3D 引擎，是"让 DOM 元素变成玻璃面板"的效果库

### 代码示例

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script src="liquidGL.js"></script>

<div class="liquidGL">
  <div class="content">卡片内容</div>
</div>

<script>
liquidGL({
  target: '.liquidGL',
  snapshot: 'body',
  resolution: 2.0,
  refraction: 0.01,
  bevelDepth: 0.08,    // 边缘凸起深度（模拟立体感）
  bevelWidth: 0.15,
  frost: 0,            // 毛玻璃模糊度
  shadow: true,
  specular: true,      // 高光动画
  tilt: true,          // 鼠标悬停 3D 倾斜
  tiltFactor: 5,
  magnify: 1,
});
</script>
```

### 优缺点

| 优点 | 缺点 |
|------|------|
| 极轻量，不依赖 Three.js | 不是真 3D（bevel 模拟立体，非真实 3D 块） |
| 直接作用于 DOM 元素 | 依赖 html2canvas（截图性能） |
| 自带 bevel/specular/tilt | CSS 动画内容不能实时折射 |
| 页面内最多 30 个实例 | Safari 不稳定（>50% viewport） |

### 适用判断

如果设计意图只是"平面卡片 + 玻璃质感 + 边缘折射纹理"，liquidGL 够用且成本最低。如果需要"真正的 3D 玻璃块（有厚度、有侧面）"，需要 Three.js。

---

## 5. 方案 D：@ybouane/liquidglass

### 概述

- GitHub: https://github.com/ybouane/liquidglass（105 stars）
- npm: `@ybouane/liquidglass`
- 原理：SVG foreignObject → Canvas rasterize → WebGL fragment shader
- 技术更强于 liquidGL：Blinn-Phong 多光源、Fresnel、色差、层叠合成

### 代码示例

```js
import { LiquidGlass } from '@ybouane/liquidglass';

const instance = await LiquidGlass.init({
  root: document.querySelector('#root'),
  glassElements: [document.querySelector('.glass-card')],
  defaults: {
    cornerRadius: 24,
    refraction: 0.8,
    blurAmount: 0.25,
    chromAberration: 0.05,
    specular: 0.3,
    zRadius: 40,        // bevel 深度
  }
});
```

### 优缺点

| 优点 | 缺点 |
|------|------|
| 更强光学模拟（Fresnel、Blinn-Phong） | 每个 glass 元素一个 WebGL context（浏览器上限 ~16） |
| 层叠玻璃互相折射 | 初始化开销大 |
| npm 包，TypeScript 类型 | glass 元素必须是 root 的直接子元素 |
| 拖拽交互内置 | 嵌套玻璃需要多次 init() |

---

## 6. 方案 E：electron-liquid-glass（原生 macOS）

### 概述

- GitHub: https://github.com/Meridius-Labs/electron-liquid-glass（519 stars）
- npm: `electron-liquid-glass`
- 原理：Objective-C++ 调用 macOS `NSGlassEffectView` 私有 API
- **macOS 26+ (Tahoe) 专属**

### 代码示例

```js
const liquidGlass = require('electron-liquid-glass');

const win = new BrowserWindow({
  transparent: true,
  // 不要同时用 vibrancy
});

win.webContents.once('did-finish-load', () => {
  liquidGlass.addView(win.getNativeWindowHandle(), {
    cornerRadius: 16,
    tintColor: '#44000010',
    opaque: false,
  });
});
```

### 适用判断

- 如果目标只有 macOS 26+ 用户，这是效果最好、性能最优的方案
- 但不跨平台，且依赖 macOS 私有 API（可能被 Apple 变更）
- 可作为 macOS 高版本的**增强层**，低版本 fallback 到 WebGL 方案

---

## 7. 方案 F：PixiJS + Filters

### 能力

- `BackdropBlurFilter` — 背景模糊
- `BevelFilter` — 3D 凸起边缘
- `KawaseBlurFilter` — 高效模糊
- `DisplacementFilter` — 位移贴图（可做折射）
- `ReflectionFilter` — 反射

### 判断

PixiJS 是 2D 渲染引擎，做"平面毛玻璃"可以，做"3D 玻璃块"不行。且项目不依赖 PixiJS，引入意义不大。**不推荐**。

---

## 8. 方案 G：纯 CSS glassmorphism

```css
.glass {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
```

### 判断

做不到：
- 真实折射/色差
- 3D 立体厚度
- 边缘发光/bevel
- 粒子光斑

只能做最基础的毛玻璃效果。但可以作为 WebGL 方案的 **fallback**（GPU 不支持时降级）。

---

## 9. 缩放动画方案

### 方案 A：@react-spring/three + R3F

```bash
bun add @react-spring/three
```

```tsx
import { useSpring, animated } from '@react-spring/three'
import { useState } from 'react'

function GlassCard() {
  const [expanded, setExpanded] = useState(false)

  const { scale, position } = useSpring({
    scale: expanded ? [2, 2.5, 1] : [1, 1, 1],
    position: expanded ? [0, 0, 0] : [0, -1, 0],
    config: { mass: 1, tension: 170, friction: 26 },
  })

  return (
    <animated.mesh
      scale={scale}
      position={position}
      onClick={() => setExpanded(!expanded)}
    >
      <roundedBoxGeometry args={[3, 2, 0.15, 4, 0.2]} />
      <MeshTransmissionMaterial {...glassProps} />
    </animated.mesh>
  )
}
```

**优点**：物理弹簧动画，手感好；与 R3F 原生集成。

### 方案 B：GSAP + Three.js

```js
import gsap from 'gsap'

// 在 useFrame 或 ref callback 中
gsap.to(meshRef.current.scale, {
  x: 2, y: 2.5, z: 1,
  duration: 0.6,
  ease: 'back.out(1.7)',
})
```

**优点**：GSAP 缓动函数库极丰富，`back.out` 弹性效果好。
**缺点**：需要手动管理 Three.js 对象生命周期。

### 方案 C：drei 的 Float + useFrame

```tsx
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'

function GlassCard({ expanded }) {
  const meshRef = useRef()

  useFrame((_, delta) => {
    const target = expanded ? 2 : 1
    meshRef.current.scale.x += (target - meshRef.current.scale.x) * delta * 5
    meshRef.current.scale.y += (target - meshRef.current.scale.y) * delta * 5
  })

  return <mesh ref={meshRef}>...</mesh>
}
```

**优点**：零依赖，最轻量。
**缺点**：手写 lerp，没有弹簧物理。

### 推荐：@react-spring/three

与 R3F 生态最搭，弹簧物理动画手感最好，声明式 API 与 React 一致。

---

## 10. @specy/liquid-glass-react

### 概述

- GitHub: https://github.com/Specy/liquid-glass（140 stars）
- npm: `@specy/liquid-glass-react`
- **基于 Three.js 的 React 组件**，封装了玻璃效果

### 代码示例

```tsx
import { LiquidGlass } from '@specy/liquid-glass-react'

<LiquidGlass
  glassStyle={{
    depth: 0.5,
    segments: 4,
    radius: 16,
    roughness: 0.1,
    transmission: 1,
    reflectivity: 0.5,
    ior: 1.5,
    dispersion: 0.03,
    thickness: 0.5,
  }}
  style="border-radius: 16px;"
>
  <div>卡片内容</div>
</LiquidGlass>
```

### 注意

- 初始化开销大，文档强调"minimize re-renders"
- 内部截屏 targetElement 实现背景折射
- 适合少量核心 UI 元素，不适合大量列表

---

## 11. 推荐方案

### 主方案：R3F + drei（方案 B）

**理由**：

1. **真 3D 立体感** — `RoundedBox` 几何体有真实厚度（设计图要求 3D 玻璃块）
2. **最强材质** — `MeshTransmissionMaterial` 色差/折射/各向异性模糊全支持
3. **React 原生** — 项目已用 React 19，R3F v9 直接对应
4. **粒子内置** — `Sparkles` 组件直接出设计图中的散落光斑
5. **动画生态** — `@react-spring/three` 做缩放/展开动画
6. **悬浮效果** — `Float` 组件做微浮动
7. **文档齐全** — drei 文档 + Three.js 文档 + 大量社区示例

### 技术栈

```
@react-three/fiber   — React 渲染器
@react-three/drei    — 材质/几何体/特效组件
@react-spring/three  — 弹簧物理动画
three                — 底层 3D 引擎
```

### 降级策略

```
macOS 26+ 高版本    → electron-liquid-glass 原生效果（可选增强）
WebGL 2 支持        → R3F + MeshTransmissionMaterial（主方案）
WebGL 1 fallback    → liquidGL 或 @ybouane/liquidglass（2D 玻璃）
无 WebGL            → CSS glassmorphism（最低降级）
```

### 预估性能

- Electron 41 内置 Chromium，GPU 加速默认开启
- 单个玻璃卡片 + 粒子 + 环境光：MacBook Air M1 稳定 60fps
- 展开动画（scale 变化）不触发额外 render pass，流畅
- MeshTransmissionMaterial 的额外 render pass 是主要开销，控制 `samples` 和 `resolution` 可调节

### 预估开发成本

| 阶段 | 工作量 |
|------|--------|
| 搭建 R3F Canvas + 基础场景 | 0.5 天 |
| 玻璃卡片材质调参 | 0.5 天 |
| 缩放/展开动画 | 0.5 天 |
| 粒子/光斑效果 | 0.5 天 |
| 与现有 React UI 集成（HTML overlay） | 1 天 |
| 桌面背景透传调试 | 0.5 天 |
| **总计** | **~3 天** |

---

## 12. 关键参考链接

### 文档
- Three.js MeshPhysicalMaterial: https://threejs.org/docs/#api/en/materials/MeshPhysicalMaterial
- R3F 入门: https://r3f.docs.pmnd.rs/getting-started/introduction
- drei MeshTransmissionMaterial: https://github.com/pmndrs/drei/blob/master/docs/shaders/mesh-transmission-material.mdx
- drei MeshRefractionMaterial: https://github.com/pmndrs/drei/blob/master/docs/shaders/mesh-refraction-material.mdx
- @react-spring/three: https://www.react-spring.dev/docs/guides/react-three-fiber

### npm 包
- `three` — Three.js 核心
- `@react-three/fiber` — React Three Fiber (v9 for React 19)
- `@react-three/drei` — 实用工具集
- `@react-spring/three` — 3D 弹簧动画
- `@specy/liquid-glass-react` — 封装好的玻璃 React 组件
- `@ybouane/liquidglass` — 轻量 WebGL 玻璃效果
- `electron-liquid-glass` — macOS 原生玻璃效果

### 示例/Demo
- Three.js transmission example: https://threejs.org/examples/webgl_materials_physical_transmission.html
- drei 玻璃 demo: 在 drei storybook 中搜索 "MeshTransmissionMaterial"
- liquidGL: https://github.com/naughtyduk/liquidGL

---

## 13. 与现有 electron-glass-research 的关系

| 层 | 负责 | 文档 |
|----|------|------|
| 系统层 | Electron vibrancy / NSVisualEffectView → 桌面壁纸模糊 | electron-glass-research.md |
| WebGL 层 | R3F + drei → 3D 玻璃块 + 粒子 + 动画 | 本文 |
| CSS 层 | backdrop-filter + rgba → 窗口内卡片毛玻璃 | electron-glass-research.md 第 3 节 |

**组合使用**：Electron 窗口 `transparent: true` + vibrancy 提供桌面模糊底层 → R3F Canvas `alpha: true` 叠加 3D 玻璃卡片 → CSS 处理非 3D 的普通 UI 元素。
