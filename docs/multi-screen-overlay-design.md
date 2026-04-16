# 多屏 Overlay 技术方案设计

> GitHub Issue #4: 多屏幕场景下的 Overlay 触手跨屏幕跟随

**调研人**：vault-researcher  
**调研日期**：2026-04-16  
**涉及模块**：overlay-window.ts、overlay-renderer.ts、terminal-window.ts

---

## 一、现状分析

### 现有架构

**overlay-window.ts（已经是多屏设计！）**

代码已包含完整的多屏支持基础设施：

```typescript
// 每个显示器一个 overlay 窗口
const overlays = new Map<number, OverlayEntry>()

interface OverlayEntry {
  win: BrowserWindow
  displayId: number
  originX: number; originY: number
  width: number; height: number
}

// 核心函数：每个显示器分配独立 overlay
export function updateWindowPositions(positions: ...): void {
  // 1. 按显示器分组终端窗口
  const byDisplay = new Map<number, { display: Electron.Display; positions: ... }>()
  for (const p of positions) {
    const centerX = p.x + p.w / 2
    const centerY = p.y + p.h / 2
    const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
    // 按 displayId 分组
  }
  
  // 2. 为每个活跃显示器创建/管理 overlay
  for (const [displayId, group] of byDisplay) {
    let entry = overlays.get(displayId)
    if (!entry || entry.win.isDestroyed()) {
      entry = createOverlayForDisplay(group.display)  // 创建新 overlay
      overlays.set(displayId, entry)
    }
    // 检查分辨率变化、热插拔
  }
  
  // 3. 关键：发送 ALL 终端窗口给每个 overlay（包括其他屏幕的）
  // 这样触手可以跨屏延伸
  const adjusted = positions.map(p => ({
    ...p,
    x: p.x - entry!.originX,  // 相对于该显示器原点
    y: p.y - entry!.originY
  }))
  entry.win.webContents.send('window-positions', adjusted)
}
```

**现状评价**：
- ✅ 已实现多 overlay 动态创建/销毁
- ✅ 按显示器分组终端窗口
- ✅ 热插拔/分辨率切换支持
- ✅ 所有 overlay 收到所有窗口坐标（支持跨屏触手）
- ⚠️ 但存在问题：跨屏触手被截断（见下文）

### 终端窗口位置数据流

**全局坐标系**

Electron 的多屏坐标系统（macOS/Windows/Linux 统一）：

```
┌─────────────────────┬──────────────────────┐
│   Display 0         │    Display 1         │
│   (id: 1)           │    (id: 2)           │
│ bounds:             │  bounds:             │
│ x=0, y=0            │  x=1440, y=0         │
│ w=1440, h=900       │  w=2560, h=1440      │
│                     │                      │
│  Terminal A         │   Terminal B         │
│  global: (100,100)  │   global: (1540,100) │
│          w=300      │            w=300     │
│                     │                      │
└─────────────────────┴──────────────────────┘
```

**数据流**：

1. **terminal-window.ts** `getAllTerminalPositions()`：
   - 调用 `session.win.getBounds()` → 全局坐标
   - 返回所有终端窗口的全局坐标

2. **overlay-window.ts** `updateWindowPositions(positions)`：
   - 接收全局坐标
   - 按显示器分组
   - **转换为相对坐标**：
     ```
     adjusted.x = global.x - display.originX
     adjusted.y = global.y - display.originY
     ```
   - 发送给该显示器的 overlay renderer

3. **overlay-renderer.ts**（在 overlay 进程运行）：
   - 收到相对坐标
   - 在自己的显示器（canvas 大小 = display 大小）上渲染触手

### 现有问题

#### 问题 1：跨屏触手被截断（核心问题）

**场景**：Terminal A 在 Display 0，Terminal B 在 Display 1，希望渲染连接触手

**当前行为**：

Display 0 的 overlay renderer 收到：
```javascript
positions = [
  { id: A, x: 100, y: 100, w: 300, h: 200 },   // A 本地坐标
  { id: B, x: 100-1440=-1340, y: 100, w: 300 }  // B 的坐标被转换为负数！
]
```

Display 1 的 overlay renderer 收到：
```javascript
positions = [
  { id: A, x: 100-1440=-1340, y: 100 },   // A 的坐标是负数
  { id: B, x: 1540-1440=100, y: 100 }     // B 本地坐标
]
```

**Bezier 曲线渲染时**：
- 如果两个端点都在当前 overlay 的 canvas 范围内 → 正常渲染
- 如果端点在负坐标或超出 canvas → **被 WebGL viewport 截断**

**根本原因**：
overlay renderer 使用本 display 的坐标系（宽高=display 的宽高）。两个 display 的 canvas 不重叠，触手无法真正跨屏延伸。

#### 问题 2：终端窗口移动到新屏幕

**场景**：用户拖动 Terminal A 从 Display 0 到 Display 1

**当前代码**：
```typescript
win.on('move', broadcastPositions)  // terminal-window.ts
```

**响应流程**：
1. Terminal A move 事件触发 → broadcastPositions()
2. getAllTerminalPositions() 返回新坐标（A 现在在 Display 1）
3. updateWindowPositions() 重新分组
4. Display 0 overlay 仍然收到 A 的坐标（现在是负值）
5. Display 1 overlay 收到 A 的本地坐标

**问题**：Display 0 的 overlay 继续尝试渲染已离开该屏幕的 A，坐标无效

#### 问题 3：多屏 DPR（Device Pixel Ratio）混合

**macOS/Windows 特有**：
- 主屏幕可能是 Retina (DPR=2)
- 外接屏幕可能是标准 (DPR=1)

**当前设计**：
```typescript
// overlay-renderer.ts
function resize(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  // ...
}
```

**问题**：每个 overlay 正确地使用了自己的 DPR，但触手连接的两个 box 可能在不同 DPR 的屏幕上，转换复杂

---

## 二、需求理解

### 用户场景

**Scenario A：终端分布在多屏**
```
Terminal A (Display 0: 1440x900)    Terminal B (Display 1: 2560x1440)
├─ send_msg(to="Bob")
└─ 消息流通过触手连接，跨越两屏
```

**Scenario B：Panel 主窗口和终端不在同屏**
```
Panel (Display 0)
  ├─ Member 列表
  └─ 显示 Terminal A (Display 0) 和 Terminal B (Display 1)
    └─ 触手应该在两个 display 上都渲染
```

**Scenario C：热插拔/分辨率变化**
```
初始：Laptop (1440x900) + External (2560x1440)
用户拆掉 External → Overlay 动态销毁
用户插上新 4K (3840x2160) → Overlay 动态创建
终端窗口自动分布在存活的显示器
```

### 核心需求

1. **触手必须跨屏幕渲染**：即使两个 box 在不同 display，也要看到完整的 Bezier 曲线
2. **动态 overlay 生命周期**：display 插入创建，拔出销毁
3. **终端窗口自动分配**：移动到新屏幕时，overlay 自动重新分组
4. **坐标转换无损**：混合 DPR 时保持视觉准确性
5. **性能不劣化**：多 overlay 并行渲染不应显著增加 CPU 使用

---

## 三、技术方案

### 方案对比

#### 方案 A：全局坐标 Overlay（不可行）

创建一个全屏透明窗口覆盖所有 display。

**优点**：
- 触手天然不会被截断
- 坐标转换简单

**缺点**：
- ❌ Electron 不支持跨多个 display 的透明窗口
- ❌ macOS 窗口焦点/z-order 管理问题
- ❌ 多屏 DPR 处理极其复杂

**结论**：不可行

---

#### 方案 B：Per-Display Canvas + Bridge Rendering（推荐）

**核心思路**：
- 保持每 display 一个 overlay
- 修改 renderer 逻辑：识别触手端点位置，判断是否跨屏
- 跨屏触手在两个 display 的 overlay 上各渲染一段

**架构**：

```
Terminal-Window (main)
  └─ getAllTerminalPositions()
     ├─ 返回全局坐标
     └─ 标记 box 所属 display

Overlay-Window (main)
  └─ updateWindowPositions(positions)
     ├─ 按 display 分组
     ├─ 标记跨屏连接信息
     └─ 发送给各 overlay renderer

Overlay-Renderer (Display 0)
  ├─ 收到 positions （标记了跨屏信息）
  ├─ 渲染本屏 tentacles
  └─ 对于跨屏 tentacles，只渲染 "源头一段"

Overlay-Renderer (Display 1)
  ├─ 收到 positions （标记了跨屏信息）
  ├─ 渲染本屏 tentacles
  └─ 对于跨屏 tentacles，只渲染 "目标一段"
```

**详细实现**：

##### 1. 增强坐标数据结构

```typescript
// overlay-window.ts
interface BoxInfo {
  id: number
  memberName: string
  isLeader: boolean
  x: number
  y: number
  w: number
  h: number
  color: number[]
  displayId: number  // ← NEW：标记所在 display
  globalX: number    // ← NEW：全局坐标（用于判断跨屏）
  globalY: number
}

export function updateWindowPositions(positions: ...): void {
  // 标记每个 box 的 displayId
  const withDisplayId = positions.map(p => {
    const centerX = p.x + p.w / 2
    const centerY = p.y + p.h / 2
    const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
    return {
      ...p,
      displayId: display.id,
      globalX: p.x,
      globalY: p.y
    }
  })

  // 按 display 分组
  for (const [displayId, entry] of overlays) {
    // 发送 ALL positions 及其 displayId
    const adjusted = withDisplayId.map(p => ({
      ...p,
      x: p.x - entry!.originX,
      y: p.y - entry!.originY,
      // displayId / globalX/Y 保留，renderer 用于判断跨屏
    }))
    entry.win.webContents.send('window-positions', adjusted)
  }
}
```

##### 2. Renderer 侧跨屏检测与截断

```typescript
// overlay-renderer.ts
function computeTentacles(boxes: BoxInfo[]): TentacleData[] {
  const result: TentacleData[] = []
  
  const myDisplayId = (window as any).__overlayDisplayId // 注入到 preload
  const myDprFactor = window.devicePixelRatio || 1
  
  // 遍历所有 pair 生成触手
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const boxA = boxes[i]
      const boxB = boxes[j]
      
      const isACrossScreen = boxA.displayId !== myDisplayId
      const isBCrossScreen = boxB.displayId !== myDisplayId
      
      // 只有两种情况才渲染：
      // 1. 两个都在本屏 → 完整触手
      // 2. 一个在本屏，一个在另一屏 → 渲染本屏这一段（bridge）
      
      if (!isACrossScreen && !isBCrossScreen) {
        // 情况 1：本屏内触手
        result.push(computeTentacle(boxA, boxB, myDprFactor))
      } else if (!isACrossScreen && isBCrossScreen) {
        // 情况 2a：A 本屏，B 他屏 → 渲染 A 到屏幕边界的一段
        const bridgeTentacle = computeBridgeTentacle(boxA, boxB, myDprFactor, 'from')
        result.push(bridgeTentacle)
      } else if (isACrossScreen && !isBCrossScreen) {
        // 情况 2b：A 他屏，B 本屏 → 渲染屏幕边界到 B 的一段
        const bridgeTentacle = computeBridgeTentacle(boxA, boxB, myDprFactor, 'to')
        result.push(bridgeTentacle)
      }
      // else：两个都在他屏 → 不渲染
    }
  }
  
  return result
}

function computeBridgeTentacle(
  boxA: BoxInfo, boxB: BoxInfo, dpr: number, direction: 'from' | 'to'
): TentacleData {
  // 计算触手在屏幕边界处的截断点
  // 使用 Bezier 参数进行二分搜索
  
  const from = direction === 'from' ? boxA : boxB
  const to = direction === 'from' ? boxB : boxA
  
  // 计算原始 Bezier 曲线
  const fullBezier = computeBezierPath(from, to)
  
  // 在屏幕边界处截断
  const canvasBounds = {
    x: 0, y: 0,
    w: window.innerWidth * dpr,
    h: window.innerHeight * dpr
  }
  
  const [p0, p1, p2, p3, headT, tailT] = truncateBezierAtBoundary(
    fullBezier, canvasBounds, direction
  )
  
  return {
    p0, p1, p2, p3,
    reach: 1.0,
    headPos: headT,
    tailPos: tailT,
    fuseSrc: 1.0,
    fuseDst: 1.0,
    colorA: from.color,
    colorB: to.color
  }
}

function truncateBezierAtBoundary(
  bezier: BezierPath,
  bounds: { x, y, w, h },
  direction: 'from' | 'to'
): [p0, p1, p2, p3, headT, tailT] {
  // 二分搜索：找到 Bezier 曲线与屏幕边界的交点
  // 使用 GPU-style SDF（signed distance to boundary）
  
  // 伪代码：
  // t_start = direction === 'from' ? 0 : 1
  // t_end = direction === 'from' ? 1 : 0
  // 对于每个 0.01 的 step，计算 bezierAt(t) 是否在 bounds 内
  // 找到第一个出界的点，记为 t_boundary
  
  // 返回截断后的参数和新的 p0/p1/p2/p3
  // ...
}
```

##### 3. Preload 注入 displayId

```typescript
// preload/overlay-preload.ts
const { ipcRenderer } = require('electron')

ipcRenderer.on('init-display', (_event, displayId: number, dpr: number) => {
  (window as any).__overlayDisplayId = displayId
  (window as any).__overlayDpr = dpr
})
```

##### 4. Main 发送 displayId 给 overlay

```typescript
// overlay-window.ts
function createOverlayForDisplay(display: Electron.Display): OverlayEntry {
  // ... 创建窗口
  
  win.webContents.on('dom-ready', () => {
    win.webContents.send('init-display', display.id, display.scaleFactor)
  })
  
  // ...
}
```

---

### 方案 C：全局坐标转换库（备选）

若未来需要更复杂的跨屏特效，创建坐标转换库：

```typescript
// lib/multi-display-coords.ts
class MultiDisplayCoordTransform {
  displays: Electron.Display[]
  
  globalToLocalInDisplay(globalPt: Point, displayId: number): Point {
    const display = this.displays.find(d => d.id === displayId)
    if (!display) throw new Error(`Display ${displayId} not found`)
    return {
      x: globalPt.x - display.bounds.x,
      y: globalPt.y - display.bounds.y
    }
  }
  
  localToGlobalInDisplay(localPt: Point, displayId: number): Point {
    const display = this.displays.find(d => d.id === displayId)
    if (!display) throw new Error(`Display ${displayId} not found`)
    return {
      x: localPt.x + display.bounds.x,
      y: localPt.y + display.bounds.y
    }
  }
  
  bezierIntersectsBoundary(p0: Point, p3: Point, displayId: number): boolean {
    // Bezier 曲线是否跨越屏幕边界
  }
  
  truncateBezierAtBoundary(...): BezierSegment {
    // 截断 Bezier 曲线
  }
}
```

---

## 四、实现步骤

### Phase 1：基础设施（已完成）

- ✅ overlay-window.ts 已支持多 display overlay 创建/销毁
- ✅ 终端窗口分组逻辑已就位
- ✅ 坐标转换（全局→相对）已实现

### Phase 2：数据结构增强

1. **修改 BoxInfo 接口**
   - 添加 `displayId`, `globalX`, `globalY`
   - 文件：overlay-window.ts (更新接口和 updateWindowPositions)

2. **更新 IPC 消息格式**
   - 从 window-positions 发送增强的 BoxInfo
   - 确保向后兼容性

### Phase 3：Renderer 侧跨屏检测

1. **Preload 注入**
   - 在 overlay-preload.ts 中接收 displayId
   - 存储到 window 对象

2. **跨屏 Tentacle 逻辑**
   - 修改 overlay-renderer.ts:
     - 添加 `displayId` 检测
     - 对于跨屏 pair，调用 `computeBridgeTentacle()`
     - 截断 Bezier 曲线至屏幕边界

3. **边界截断算法**
   - 实现二分搜索找交点
   - 计算截断后的 p0/p1/p2/p3

### Phase 4：测试与优化

1. 单屏验证（回归测试）
2. 双屏验证（触手连接）
3. 动态 display 变化（热插拔）
4. 混合 DPR 验证

---

## 五、风险分析

### 技术风险

| 风险 | 等级 | 缓解措施 |
|-----|------|--------|
| Bezier 二分搜索精度 | 中 | 使用自适应 step size，参考 TentacleRenderer 的 BEZIER_SAMPLES |
| 多 DPR 坐标混淆 | 中 | 每个 overlay 独立 DPR，bridge 时 scale 坐标 |
| WebGL 坐标系不一致 | 低 | 每个 overlay canvas 大小匹配 display，无歧义 |
| 触手闪烁/抖动 | 低 | 预帧（pre-frame）计算 bridge 端点，确保平滑 |

### 性能风险

| 风险 | 等级 | 缓解措施 |
|-----|------|--------|
| 多 overlay 渲染 | 中 | 每个 overlay 独立 RequestAnimationFrame，空闲时休眠 |
| Bezier 二分搜索 CPU | 低 | 缓存上一帧的截断点，仅在 box 移动时重算 |
| 内存碎片（频繁创建/销毁） | 低 | Pool overlay 对象，销毁时缓存不释放 |

### 功能风险

| 风险 | 等级 | 缓解措施 |
|-----|------|--------|
| Display 拔出时残留 overlay | 低 | screen.getAllDisplays() 定期同步，orphan 检测 |
| 终端窗口卡在屏幕边界 | 低 | 触手在边界处逐渐淡出（tailFade smoothstep） |
| macOS fullscreen 模式冲突 | 中 | 测试并文档化限制 |

---

## 六、实现细节

### 坐标转换算法

#### 1. 全局→相对（已有）

```
globalPt → 确定所属 display → 减去 display.origin → localPt
```

#### 2. 跨屏 Bezier 截断（新增）

**输入**：
- 原始 Bezier 参数：p0, p1, p2, p3（相对坐标）
- 屏幕边界：canvas size (w, h)
- 方向：'from'（源端截断）或 'to'（目标端截断）

**输出**：
- 截断后的参数：p0', p1', p2', p3'
- 有效范围：headT, tailPos（在 [0,1] 中的范围）

**算法**（使用 SDF 思想）：

```javascript
function truncateBezier(p0, p1, p2, p3, bounds, direction) {
  const step = 0.01  // 精度：1% 的曲线长度
  const maxIterations = 100
  
  let t_boundary = direction === 'from' ? 0 : 1
  
  for (const t of generateTSteps(direction, step)) {
    const pt = bezierAt(p0, p1, p2, p3, t)
    
    // 检查是否在边界内
    if (isOutOfBounds(pt, bounds)) {
      t_boundary = t
      break  // direction='from': 第一个出界点
             // direction='to': 最后一个出界点
    }
  }
  
  // 返回截断后的曲线
  if (direction === 'from') {
    // 保留 [t_boundary, 1] 部分
    return {
      p0: bezierAt(p0, p1, p2, p3, t_boundary),
      p1, p2, p3,  // 简化：保持原控制点（精度略低但快）
      headT: 1,
      tailT: t_boundary
    }
  } else {
    // 保留 [0, t_boundary] 部分
    return {
      p0, p1, p2,
      p3: bezierAt(p0, p1, p2, p3, t_boundary),
      headT: t_boundary,
      tailT: 0
    }
  }
}
```

### DPR 处理

**多屏 DPR 场景**：

```
Display 0 (Retina, DPR=2):  1440x900 logical = 2880x1800 physical
Display 1 (Standard, DPR=1): 2560x1440 logical = 2560x1440 physical
```

**处理方式**：

1. **Overlay 侧**：每个 overlay 独立用自己的 DPR
   ```typescript
   canvas.width = window.innerWidth * dpr
   canvas.height = window.innerHeight * dpr
   ```

2. **坐标转换**：
   - 全局坐标（系统坐标系，独立于 DPR）
   - 转换为相对坐标时，直接减去 display.origin
   - 无需 DPR 缩放（系统坐标已处理）

3. **Bridge Tentacle**：
   - 端点坐标：直接使用相对坐标（已正确）
   - Bezier 曲线：在每个 overlay 的坐标系中绘制（独立 DPR）
   - 不需要跨 DPR 转换

**核心原则**：坐标始终在系统坐标系中，DPR 只影响 canvas 分辨率

---

## 七、对需求的理解总结

**GitHub Issue #4 的本质**：用户有多个物理显示器，Panel 应该在所有屏幕上都能显示触手特效连接终端窗口。

**当前缺陷**：
1. Overlay 基础设施已支持多屏，但 renderer 无法跨屏幕渲染触手
2. 跨屏的 Bezier 曲线被 WebGL viewport 截断，导致触手视觉不连贯

**解决思路**：
- 保持每 display 一个独立 overlay（WebGL context 不能共享）
- 修改 renderer 逻辑，检测触手是否跨屏
- 对于跨屏触手，在两个 overlay 上各渲染一段（bridge）
- 使用 Bezier 二分搜索算法找到屏幕边界处的截断点

**关键创新**：
- **Bridge Tentacle 概念**：跨屏触手在屏幕边界处自然截断并淡出
- **Per-Display 独立 DPR**：无需复杂的 DPR 转换，每个 overlay 只关心自己的 DPR
- **动态 displayId 标记**：在 renderer 中识别跨屏对，实现智能截断

**预期效果**：
- ✅ 用户在多屏场景下看到完整的触手特效
- ✅ 动态 display 变化时自动适应
- ✅ 性能无显著劣化
- ✅ 代码改动局限于 renderer 和 window 管理层

---

## 八、后续行动

### 立即（阶段 2-3）

1. 增强 BoxInfo 数据结构，添加 displayId 标记
2. 在 overlay-window.ts 中标记每个 box 的 displayId
3. 修改 overlay-renderer.ts 检测跨屏对
4. 实现 Bezier 二分截断算法

### 中期（测试阶段）

1. 单屏回归测试
2. 双屏验证（实体设备或虚拟机测试）
3. 热插拔/分辨率变化测试

### 长期（优化）

1. 缓存 bridge tentacle 计算结果
2. 性能分析与 GPU 优化
3. 文档补充（多屏场景下的故障排查）

