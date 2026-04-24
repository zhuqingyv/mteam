# 液态玻璃拉伸方案

> 桌面宠物点击 → 聊天窗口。把现在"等比 scale 放大成巨型卡片"改成"液态水滴被拉开"。
>
> 调研输入：`packages/backend/src/fx/*` 六个文件 + 当前 `GlassCard3D.tsx` / `App.tsx` / `electron-main/main.ts`。

---

## 一、fx/ 特效到底做了什么

### 1.1 总览：全都是 WebGL2 + SDF + 全屏 quad

六个文件，剔除 `overlay-window.ts`（Electron 主进程，不渲染）和 `overlay.html` / `overlay-preload.ts`（壳），真正画画的四个模块形成一个**两级抽象**：

| 文件 | 角色 | 技术 |
|---|---|---|
| `liquid-border-lib.ts` | 可复用库：带 wobble 的液态圆角矩形边框 | WebGL2 + SDF + fragment noise |
| `tentacle-renderer.ts` | 可复用库：两点间贝塞尔触手 | WebGL2 + Cubic Bezier + SDF |
| `panel-border.ts` | 主面板窗口的多色流动边框（应用层） | 复用 liquid-border 的 shader 思想，但独立写一份 |
| `terminal-border.ts` | 单个成员终端窗口的单色液态边框（应用层） | 同上，独立一份 |
| `overlay-renderer.ts` | 跨屏透明 overlay，画终端之间的触手+消息粒子 | 综合运用 SDF + Bezier + 消息生命周期 |
| `overlay-window.ts` | Electron 主进程：每块物理显示器创建一个透明 overlay BrowserWindow | BrowserWindow + `transparent:true` + `setIgnoreMouseEvents` |

关键观察：**所有特效统一技术栈 = WebGL2 + SDF + 全屏 quad + fragment shader 里算距离/颜色**。没有 Three.js，没有 Canvas 2D，全是手写 shader。

### 1.2 核心 SDF：roundedBoxSDF

几乎每个 fragment shader 都有这个函数，是整套特效的基石：

```glsl
float roundedBoxSDF(vec2 p, vec2 center, vec2 halfSize, float r) {
    vec2 d = abs(p - center) - halfSize + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
```

返回点 p 到圆角矩形的距离，内负外正。只要调 `halfSize` 和 `r` 就能**任意改变圆角矩形的宽高/圆角**，不需要重新创建几何体——这是液态拉伸可以连续插值的根本原因。

### 1.3 液态边框怎么液态

以 `terminal-border.ts:87-103` / `liquid-border-lib.ts:363-367` 为例：

1. 计算每个 fragment 到圆角矩形边的 SDF（有符号距离）。
2. 用点的极角 `atan(y, x)` 算出它在边框上的"角度位置"。
3. **用三层 sin 叠加 wobble**：频率 5/8/13，相位随 `u_time` 漂移，振幅 1.0/0.6/0.4 像素。
4. 把 wobble 加到边的"半宽"上 → `float hw = bw * 0.5 + wobble;`
5. `abs(sdf) - hw` 配 `smoothstep` 形成柔边。

Wobble 强度是 **`u_activity`** 驱动的：`speed = 1.0 + u_activity * 2.0;`——闲时慢、活跃时快。这个 activity 对应方案里"拉伸过程中液态流动加剧"是**直接可复用的钩子**。

### 1.4 触手怎么跟随

`tentacle-renderer.ts` / `overlay-renderer.ts`：

1. **CPU 端**算两个矩形的边界出口（`findEdgeExit` 沿法线步进找 SDF 正点），以及贝塞尔的四个控制点。
2. 控制点加上时间驱动的 sin/cos **扭动偏移** → 触手会像水蛇摆动。
3. **GPU 端** fragment shader 里对每个 fragment：
   - 沿贝塞尔采样 32/12 个点，取最近的 t 和距离；
   - 计算宽度曲线（`rootW=1.2bw, midW=0.35bw`，根部粗中间细），加上 head/tail 的 `smoothstep` 渐细；
   - 最后 `safeSmin(boxSDF, tentacleSDF, kRoot)` ——**关键：把矩形的 SDF 和触手的 SDF 做光滑 min**，这样两端和触手无缝粘在一起，像水滴融合。

生命周期参数 `headPos / tailPos / fuseSrc / fuseDst` 决定触手是在伸出、接触、还是被吸收（`overlay-renderer.ts:347-386`）。消息事件到达 → 计算 mt[0,1] → 映射到这些参数 → fragment shader 实时画。

### 1.5 怎么叠在窗口上

`overlay-window.ts`：

- 每个物理 display 开一个 `BrowserWindow`：`transparent:true + frame:false + hasShadow:false + alwaysOnTop + focusable:false + setIgnoreMouseEvents(true, {forward:true})`。
- 位置对齐 display.bounds，尺寸全覆盖。
- 终端窗口坐标通过 IPC 从主进程 push 到 overlay renderer（减去 overlay 原点得到相对坐标）。
- 跨屏时在 overlay-renderer.ts:466-479 用 `findBoundaryT` 把 headPos/tailPos 截断到屏幕边界，实现"从左屏伸到右屏"视觉连续。

---

## 二、可以直接复用到拉伸场景的技术

| 技术点 | 出处 | 在拉伸场景里怎么用 |
|---|---|---|
| `roundedBoxSDF` 参数化圆角矩形 | 全部 shader | 直接把 `halfSize` 从 `(250,160)` 插值到 `(450,340)`，**不是 scale**，是形状本身变了 |
| wobble 叠加（sin×3 层） | terminal-border.ts:87-92 | 拉伸过程中**加大 wobble 振幅**（从 1.0 → 3.5），边缘"被扯开"的水感 |
| `u_activity` 驱动动画速度 | terminal-border.ts:89 | 拉伸进度 t 直接喂进 activity，边缘抖得更剧烈 |
| `safeSmin` 光滑最小 | overlay-renderer.ts:134-138 | 用来**把两个同心圆角矩形做形变插值**，或做"薄片感"过渡 |
| fragment-only 渲染（全屏 quad） | 所有 shader | **拉伸期间不用 Three.js 几何体**，直接切到 fragment shader 画一个变形中的液态矩形 |
| `requestAnimationFrame` + 自适应 FPS（闲 24 / 活 60） | liquid-border-lib.ts:238-245 | 拉伸是短时高活跃，全程 60fps，拉完再回 24fps |
| Electron transparent + 无边框 + WebGL2 alpha | overlay-window.ts:22-40 | 主窗口已经是 `transparent:true`，直接复用 |
| 跨屏 SDF 截断 | overlay-renderer.ts:466-479 | **本场景用不上**（单窗口），但逻辑告诉我们：SDF 形变能做任意屏幕边界处理 |

**没法直接复用的**：
- Three.js 现在这套 `MeshTransmissionMaterial + RoundedBox` 是走**光线追踪折射**，fx/ 里没有折射，只有 SDF 剪影+边框。**拉伸的"液态感"不能完全继承 fx 的做法，需要嫁接**。

---

## 三、当前问题根因

`GlassCard3D.tsx:161-183`：

```js
groupRef.current.scale.setScalar(s);  // s: 1 → 2.4
liquidUniforms.uLiquidStrength.value = 0.1 + 0.15 * eased;
```

问题链：

1. **`group.scale` 等比放大**整个 3D 物体——`RoundedBox args={[3, 1.5, 0.4]}` 这几何体本身没变，只是世界坐标里变大了。结果：卡片在相机视锥里按原比例被放大，还是 3:1.5 的扁长方体，只是更大。
2. **相机不动，fov=34 不变**：scale=2.4 的 RoundedBox 铺满画面，相当于"镜头拉近 2.4 倍"，视觉上是"巨型卡片"而不是"窗口被撑开"。
3. **窗口尺寸从 500×320 跳到 900×680**（长宽比从 1.56 → 1.32）：Electron 窗口边界变了，但 3D 物体的长宽比（2:1）没变 → 物体相对窗口看起来又变扁了，观感混乱。
4. **液态 `uLiquidStrength` 加到 0.25**：噪声位移是**沿法线**的（`position + normal * n * strength`），这只让表面起伏更抖，不会把矩形拉长。
5. 动画只有 300ms scale，**窗口 resize 是瞬间跳变**（`setBounds(..., true)` 的 true 参数虽然 animate，但 Electron 自己的 resize 动画和 WebGL scale 动画不同步）。

简言之：现在做的是"照片放大"，不是"水滴被拉长"。

---

## 四、液态玻璃拉伸方案

### 4.1 目标形变曲线

| 维度 | 起点（500×320 窗口） | 终点（900×680 窗口） |
|---|---|---|
| 窗口 BrowserWindow | 500 × 320 | 900 × 680 |
| 3D 几何 `args` | `[3, 1.5, 0.4]`（扁长） | `[6, 4, 0.3]`（宽高都大，但更薄） |
| 长宽比 | 2.0 : 1（3/1.5） | 1.5 : 1（6/4） |
| 厚度 | 0.4 | 0.3（被拉薄） |
| 圆角 `radius` | 0.3 | 0.5（圆角随尺寸放大） |
| `uLiquidStrength` | 0.10 | 0.28（峰值中间 0.35） |
| `uLiquidFreq` | 1.8 | 1.2（拉伸后低频更"水" ） |
| wobble 幅度等价 | 无 | 边缘 wave 动画加强 |
| Camera fov / z | 34 / 4.2 | 34 / 7.5（相机后撤配合几何变大） |
| Electron 窗口 | 瞬间 setBounds | **与 3D 动画同拍缓动** |

### 4.2 架构决策：**保留 Three.js，但把 args 动画化**

放弃方案：切换到纯 fragment shader（fx/ 风格）会丢掉已有的 `MeshTransmissionMaterial` 折射/色散/焦散，**桌面壁纸透过玻璃的质感就没了**。而透过去的那层壁纸才是"液态玻璃"的灵魂。

选定方案：**Three.js 继续做折射主体**，在拉伸过程中：

1. 重建/切换几何体（`args` 动画）——RoundedBox 是 React 组件，它的 args 变化会重建 geometry，**不能每帧重建**（GC 压力巨大）。
2. 替代：**一次创建最大尺寸 geometry，用顶点 shader 把顶点压缩到当前尺寸**——morph 风格。

### 4.3 具体实施：顶点 shader 做 box morph

**核心 idea**：RoundedBox 的每个顶点 `position` 在局部坐标里有一个"原始 unit box 坐标"，我们在顶点 shader 里把它**非等比拉伸**到目标尺寸，这样 material / normal / refraction 的一切计算都保持在 GPU，零 geometry 重建。

```glsl
// 顶点 shader 追加片段
uniform vec3 uBoxScaleFrom;  // 原始 args，如 (3, 1.5, 0.4)
uniform vec3 uBoxScaleTo;    // 目标 args，如 (6, 4, 0.3)
uniform float uStretchT;     // 0..1，动画进度

// position 是基于 uBoxScaleFrom 已经 bake 过的坐标
// 关键：把 position 拆成 "相对 from 的归一化 [-1, 1]" → 再用 to 重建
vec3 unit = position / (uBoxScaleFrom * 0.5);   // ~[-1, 1]^3
vec3 stretched = unit * (uBoxScaleTo * 0.5);
vec3 base = mix(position, stretched, uStretchT);

// 在 base 上叠 noise（原有逻辑）
// 注意：noise 的 position 要用 base，不是原 position，这样液态流动
// 跟着新形状走，而不是僵在老形状上
float t = uLiquidTime * uLiquidSpeed;
float n1 = snoise(base * uLiquidFreq + vec3(t, t*0.7, t*1.3));
float n2 = snoise(base * uLiquidFreq * 2.4 + vec3(-t*1.1, t*0.4, -t*0.8));
float n = n1 * 0.7 + n2 * 0.3;
vec3 transformed = base + normal * n * uLiquidStrength;
```

**圆角会不会变畸形？** 会。RoundedBox 的圆角半径是 baked 进 geometry 的，非等比拉伸后圆角会变椭圆。这**恰好是"水滴被拉开"的视觉**——液体被拉伸时，原来对称的圆角确实会变成椭圆 hint。**不是 bug，是 feature**。

**法线重算**：非等比 scale 导致法线偏移。用 `normalMatrix = transpose(inverse(modelMatrix))` 已经由 Three.js 处理，但因为我们在顶点 shader 里手动 morph，得自己修：

```glsl
#include <beginnormal_vertex>
// 非等比缩放因子
vec3 stretchFactor = mix(vec3(1.0), uBoxScaleTo / uBoxScaleFrom, uStretchT);
// 法线按 1/s 校正（椭球法线公式）
objectNormal = normalize(objectNormal / stretchFactor);
// 再叠 noise 扰动（原有逻辑，用 base 而不是 position）
float nn = snoise(base * uLiquidFreq + vec3(nt, nt*0.7, nt*1.3));
objectNormal = normalize(objectNormal + normal * nn * uLiquidStrength * 0.6);
```

### 4.4 动画时序（推荐 600ms）

```
t ∈ [0.00, 0.15]  ——  "聚能"：uLiquidStrength 冲到 0.35，wobble 猛增
                        窗口+几何还没动，只是抖
t ∈ [0.15, 0.85]  ——  "拉伸主阶段"：
                        uStretchT 从 0 → 1（easeOutCubic）
                        Electron 窗口同步 resize（手写 rAF + setBounds）
                        camera z 从 4.2 → 7.5（相机后撤露出更大空间）
                        uLiquidStrength 按正弦钟形曲线：0.35 → 0.40 → 0.22
t ∈ [0.85, 1.00]  ——  "稳定"：液态平静下来
                        uLiquidStrength 从 0.22 → 0.08
                        完成后触发 onExpandDone
```

**300ms 太快**，液态感来不及建立。600ms 是体感"被拉开"的甜蜜点（参考 macOS Dock 放大动画 ~400ms，窗口缩放 ~500ms，我们是"液体"不是"刚体"所以更慢）。

### 4.5 Electron 窗口同步

当前 `main.ts:58-77` 的 `window:resize` IPC 是**一次跳变**。改成：

```ts
// 渲染进程每帧调
window.electronAPI.resizeStep(currentW, currentH);
// 主进程用 setBounds({...}, false) 无系统动画
// 每秒 60 次就够了，和 3D 同拍
```

关键：**取消 Electron 自带的 `animate:true`**（`setBounds(bounds, true)`），系统动画和 WebGL 动画会互相打架。让 WebGL 当主时钟，主进程被动跟。

不用 IPC 每帧（有 overhead）的替代：用 `win.setBounds` 配合 Electron 18+ 的 `setContentBounds`，配 `smooth-resize` 关掉。实测 60fps IPC 是够的（payload 只有两个数）。

### 4.6 折射/材质可以保留吗

`MeshTransmissionMaterial` 的 transmission/thickness/ior/distortion 在拉伸过程中**完全可以保持常数**。几何体 morph 后，折射仍然在每帧重算（它本来就是每帧采样 scene）。唯一要注意：

- `thickness = 0.4`：box 被拉薄后厚度感会弱。可以把 thickness 也插值 `0.4 → 0.25` 呼应变薄的 z。
- `distortion` / `distortionScale`：可以在拉伸期间瞬时加到 0.8 / 0.9，拉完回 0.4，这样折射里的桌面背景也会跟着"被拉歪"。

### 4.7 拉完之后怎么承接 HTML 内容

两个可行路径：

**路径 A（推荐）：Three.js 退位 + CSS3D 过渡**

- t=1.0 时淡出 Three.js Canvas（opacity 0.5s）
- 同时淡入 ChatView（同样 opacity 0.5s）
- 玻璃质感由 glass.css 现有的 `backdrop-filter: blur(24px) saturate(180%)` 接手 —— 已经写好了
- 用户的视觉连续性：都是"玻璃半透明"，衔接自然

**路径 B：Three.js 继续渲染大玻璃板作为 ChatView 的背景层**

- 3D Canvas 保持在 `position: absolute, z-index: 0`
- ChatView 在它上面 `z-index: 1`
- RoundedBox 继续液态抖动（低强度），ChatView 盖在玻璃表面
- 问题：`MeshTransmissionMaterial` 的折射是对 scene 里其他物体的，对 DOM 没用，还得为 HTML 单独叠 blur

**选 A**：工期快一半、性能好、现有 glass.css 已经够用。

---

## 五、实施拆分（给实现的人）

**不改 fx/ 里任何代码**。fx/ 是为多窗口边框和 overlay 服务的，和桌面宠物主体是两回事。这套方案只改：

1. `packages/renderer/src/components/GlassCard3D.tsx`
   - 增加 `uBoxScaleFrom` / `uBoxScaleTo` / `uStretchT` 三个 uniform
   - 改写顶点 shader 片段做 box morph + 法线校正
   - 动画循环改为 600ms，加入 camera z 插值和 thickness 插值
   - `EXPAND_SCALE_TARGET` 常量删除，改成 `STRETCH_DURATION_MS = 600` + 目标 args
   - RoundedBox 的 `args` 保持 `[3, 1.5, 0.4]` 不变（这是 from；morph 到 to 在 shader 里做）

2. `packages/renderer/src/App.tsx`
   - `onExpandStart` 改成**每帧推进窗口尺寸**（新增 `rafResize` 逻辑），不再一次性调 resize
   - 把 `PET_SIZE` 和 `CHAT_SIZE` 作为目标传给 GlassCard3D，让 3D 动画和窗口动画同源

3. `packages/renderer/electron-main/main.ts`
   - `window:resize` 改成两个 channel：`window:resize-step`（立即跳，不 animate）和 `window:resize-final`（可选对齐整数像素）
   - 或保持一个 channel，参数加 `animate: false`

4. **不动的文件**：fx/*, glass.css, ChatView.tsx, PetCard.tsx

**预期交付**：一个 PR，纯渲染进程 + 主进程窗口 resize 同步修改，不碰后端、不碰 overlay 系统。

---

## 六、风险和边界

| 风险 | 应对 |
|---|---|
| RoundedBox 拉伸后圆角变椭圆 | 预期效果，不修；若要圆角保持真圆，得在 shader 里识别圆角区域另做处理（复杂度翻倍，不值） |
| 法线扰动导致折射锯齿 | 已在方案里校正；上线后如果视觉有噪点，加大 MeshTransmissionMaterial 的 `samples` 到 10 |
| 60fps IPC 推窗口尺寸压力 | 实测 Electron 主进程单线程能扛 60fps 的 setBounds，超载降到 30fps 肉眼不可察 |
| macOS 窗口 resize 有系统约束（title bar、最小尺寸） | 主窗口已 `frame:false`，无 title bar；不设 minWidth/minHeight 规避 |
| 折射材质在拉伸中性能下降 | MeshTransmissionMaterial `resolution=512, samples=6` 在 morph 期间可临时降到 256 / 4，完成后恢复 |
| 用户中途再点击卡片 | 当前代码 `if (expanding) return;` 已拦截；加一个反向折叠动画对称做一份（下个 PR） |

---

## 七、一句话总结

**不要 scale，要 morph**：顶点 shader 里把 box 的 size uniform 动画化，让几何体本身变宽变薄，同时加剧液态噪声振幅和 Electron 窗口同步 resize，600ms 后淡出 Three.js 切换到 glass.css 的 ChatView。fx/ 里的 SDF + wobble 技术作为思路参考，但不直接用，因为折射质感要靠 Three.js 保留。
