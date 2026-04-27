# 胶囊交互完整规范（权威版）

> 由设计师 A / 设计师 B 两份规范合并而来，并融入 UX A 互审反馈（mnemo id:684）。
> 本文件是胶囊（CapsuleCard）展开/收起/拖动交互的唯一真源。
> **最后更新**：2026-04-27 · **作者**：merge-spec · **验证手段**：CDP + 真机多屏

---

## 0. 文档范围

覆盖胶囊窗口（CapsuleCard + ExpandedView）的完整用户交互流程，包括：
- 冷启动
- 展开 / 收起
- 快速连击打断
- 胶囊态拖动 / 展开态拖动
- 跨屏 / 跨 DPI
- 屏幕边界 clamp
- 尺寸约束、CSS 动画时间线、位置锚点

**关键代码文件**：
- `src/hooks/useCapsuleToggle.ts` — 状态机 & 时序调度
- `src/organisms/CapsuleCard/CapsuleCard.tsx` — DOM 结构
- `src/organisms/CapsuleCard/CapsuleCard.css` — 动画 & 布局
- `src/molecules/DragHandle/DragHandle.tsx` — 展开态拖拽手柄
- `electron-main/main.ts` — 窗口 resize + clamp
- `electron-main/preload.cjs` — IPC 暴露

---

## 1. 状态机

### 1.1 状态定义

| 代号 | 状态 | 窗口尺寸 | border-radius | 触发条件 |
|------|------|---------|---------------|---------|
| CA | CAPSULE（胶囊态） | 380×120 | 44px | 默认 / 收起完成 |
| EX | EXPANDING（展开中） | 动画：380→640 / 120→620 | 44→20px | 点 MenuDots |
| EXD | EXPANDED（展开态） | 640×620 | 20px | 展开动画完成 |
| CO | COLLAPSING（收起中） | 动画：640→380 / 620→120 | 20→44px | 点 X |

### 1.2 转换图

```
     ┌────────┐
     │   CA   │
     │ 380×120│ ◄─────────────┐
     └───┬────┘               │
    click .btn--dots          │ +550ms
         │                    │ (fade 200 + resize 350)
         ▼                    │
     ┌────────┐           ┌───┴────┐
     │   EX   │           │   CO   │
     │ resize │           │ fade out│
     │ +350ms │           │  body   │
     └───┬────┘           └───▲────┘
         │ body fade in       │
         │ +200ms             │ click .card__close
         ▼                    │
     ┌────────┐               │
     │  EXD   │───────────────┘
     │ 640×620│
     └────────┘
```

### 1.3 关键时序常量

```typescript
// useCapsuleToggle.ts
CAPSULE      = { width: 380, height: 120 }
EXPANDED     = { width: 640, height: 620 }
RESIZE_MS    = 350   // 窗口尺寸过渡
BODY_FADE_MS = 200   // body opacity 过渡
TOTAL_MS     = 550   // 单向总耗时
```

### 1.4 React 状态对应

| React state | 类名 | 语义 |
|-------------|------|------|
| `expanded`     | `.card--expanded`     | 已进入展开布局（logo 缩小、card__collapsed 隐藏） |
| `animating`    | `.card--animating`    | 动画进行中标记（用于锁点击、驱动视觉兜底） |
| `bodyVisible`  | `.card--body-visible` | 开始让 body 从 opacity 0 过渡到 1 |

> **命名遗留**（B-P5）：`bodyVisible` 语义是"body 开始淡入"，更精确名称应为 `bodyFadingIn`。保留现名，不做改动。

---

## 2. 冷启动

### 2.1 启动参数

| 条件 | 窗口尺寸 | 初始位置 | 首帧可见内容 |
|------|---------|---------|-------------|
| URL 无 `?expanded=1` | 380×120 | 主屏右下角 (screenW-380-40, screenH-120-80) | 胶囊态 |
| URL 有 `?expanded=1` | 640×620 | 右下角 bottom-right 锚点就地扩展 | 胶囊头 + ExpandedView body |

代码位置：
- `useCapsuleToggle.ts:9-11` — `INITIAL_EXPANDED` 从 URL 参数读取
- `useCapsuleToggle.ts:20-28` — useEffect 初始化 resize（`animate=false`，无过渡）
- `electron-main/main.ts:47-59` — createWindow 初始位置

### 2.2 首帧 React 状态

```
expanded    = INITIAL_EXPANDED ? true  : false
animating   = false
bodyVisible = INITIAL_EXPANDED ? true  : false
```

---

## 3. 展开流程（CA → EX → EXD）

### 3.1 触发

用户点击 `.btn--dots`（胶囊态右侧 MenuDots 图标）。

### 3.2 时序表

| t | 动作 | 窗口尺寸 | class | bodyVisible | 说明 |
|---|-----|---------|-------|-------------|------|
| 0 | 清理 timersRef | 380×120 | `card` | false | 防连击堆积 |
| 0 | `setExpanded(true) + setAnimating(true) + setBodyVisible(false)` | 380×120 | `card card--expanded card--animating` | false | **同步 batch 单 render**（id:584 修复） |
| +5ms | IPC `window:resize(640, 620, 'bottom-right', animate=true)` | resize 开始 | 同上 | false | Electron `setBounds(..., animate)` 触发 |
| 0→350ms | 窗口尺寸过渡 + CSS 内部过渡 | 动画中 | 同上 | false | logo/border-radius/collapsed 同步过渡 |
| +350ms | `setBodyVisible(true)` | 640×620 | `card card--expanded card--animating card--body-visible` | true | body 开始 opacity 0→1 |
| 350→550ms | body fade in | 640×620 | 同上 | true | `.card__body` opacity 过渡 200ms |
| +550ms | `setAnimating(false)` | 640×620 | `card card--expanded card--body-visible` | true | 进入稳定 EXD |

### 3.3 关键约束（id:584 已落地）

- `setExpanded` / `setAnimating` / `setBodyVisible(false)` **必须在同一 event handler 内**，由 React 18 自动 batch 单 render。禁止用 `requestAnimationFrame` 分帧，否则 `.card__body` 的 CSS transition 计时起点会被打断。
- `.card__collapsed` 在 `.card--expanded` 下 `visibility: hidden` + `transition: visibility 0s linear 180ms`，opacity 过渡完立即彻底 hidden，消除残影。

### 3.4 代码对应

```typescript
// useCapsuleToggle.ts:38-45 展开分支
setAnimating(true);
setExpanded(true);
setBodyVisible(false);
window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
schedule(() => setBodyVisible(true), RESIZE_MS);           // +350ms
schedule(() => setAnimating(false), RESIZE_MS + BODY_FADE_MS); // +550ms
```

---

## 4. 收起流程（EXD → CO → CA）

### 4.1 触发

用户点击 `.card__close`（展开态右上角 X 按钮）。

### 4.2 时序表

| t | 动作 | 窗口尺寸 | class | bodyVisible | 说明 |
|---|-----|---------|-------|-------------|------|
| 0 | 清理 timersRef | 640×620 | `card card--expanded card--body-visible` | true | - |
| 0 | `setAnimating(true) + setBodyVisible(false)` | 640×620 | `card card--expanded card--animating` | false | body 立即进入 opacity:1→0 过渡 |
| 0→200ms | body fade out | 640×620 | 同上 | false | `.card__body` opacity 200ms ease |
| +200ms | IPC `window:resize(380, 120, 'bottom-right', animate=true)` + `setExpanded(false)` | 开始 resize | `card card--animating` | false | 窗口缩放 + 切回胶囊布局 |
| 200→550ms | 窗口 resize + logo/radius/collapsed 过渡 | 动画中 | 同上 | false | `.card__collapsed` opacity 0→1 |
| +550ms | `setAnimating(false)` | 380×120 | `card` | false | 进入稳定 CA |

### 4.3 关键约束

- **先 fade out 再 resize**：用户视觉是"内容先消失 → 窗口才缩小"。
- 锚点固定 `bottom-right`：缩小后窗口右下角保持原位。
- `(expanded || animating) && <ExpandedView />`（`CapsulePage.tsx:33`）：动画期间 ExpandedView 仍挂载，避免 DOM 移除导致的闪烁。

### 4.4 代码对应

```typescript
// useCapsuleToggle.ts:46-55 收起分支
setAnimating(true);
setBodyVisible(false);
schedule(() => {
  window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true);
  setExpanded(false);
}, BODY_FADE_MS); // +200ms
schedule(() => setAnimating(false), BODY_FADE_MS + RESIZE_MS); // +550ms
```

---

## 5. 快速操作（动画中的中断）

### 5.1 打断语义（采纳 UX A 反馈 D2）

**最终决定：打断重来，不排队**。理由：排队会让用户积攒操作，UI 反馈滞后，不符合桌宠"跟手"的预期。

### 5.2 实现机制

```typescript
// useCapsuleToggle.ts:35-37
const toggle = () => {
  for (const t of timersRef.current) clearTimeout(t);
  timersRef.current = [];
  // ... 走展开或收起分支
};
```

任何时刻 toggle 入口统一清理所有 pending timer，立即按当前 `expanded` 值走对应分支。

### 5.3 典型场景

| 场景 | 行为 |
|------|------|
| 展开动画中（0~550ms）点 X | 立刻切走收起路径；视觉上"展开动画被打断 → 立即开始收起" |
| 收起动画中（0~550ms）点 MenuDots | 立刻切走展开路径；视觉上"收起被打断 → 立即展开" |
| Spam 点击 10 次 | `timersRef` 每轮被清空，定时器数不超过 2；无堆积风险 |

### 5.4 风险项（P3）

- 展开态动画中 `.card--expanded` 已加，`.card__close` 已 `pointer-events: auto`，用户可在展开动画 350ms 内点到 X → 触发收起打断（当前已正常）。
- 收起动画中 `.card--expanded` 在 t=200ms 才被移除，之前 `.card__collapsed` 是 `visibility: hidden` + `pointer-events: none`，**不会误点 MenuDots 穿透**。这是当前 CSS 已保障的约束（A 文档 P2 误判，实际不需修复）。

---

## 6. 拖动交互

### 6.1 实现机制（纠正 B 文档 §5.1 误述）

当前代码**不**使用 `ipcRenderer.send('window:start-resize')` 触发原生拖拽。实际走 CSS `-webkit-app-region: drag`：

- `.card` 整体设为 `-webkit-app-region: drag`（`CapsuleCard.css:18`）。
- `.card__body`、`.card__close`、`.btn--dots` 显式 `-webkit-app-region: no-drag`，避免覆盖按钮区域。
- Electron 自动处理鼠标按下 + 移动 → 窗口移动。

> 注：`window:start-resize` IPC 是给**未来边缘 resize 手柄**留的接口（见 `main.ts:94-100`），当前拖动不使用。

### 6.2 胶囊态拖动（CA）

| 项 | 值 |
|----|----|
| 可拖区域 | 整个胶囊（除 `.btn--dots`） |
| 拖动形态 | 原生 OS 窗口移动 |
| 手柄视觉 | 无（鼠标默认光标） |

### 6.3 展开态拖动（EXD）

| 项 | 值 |
|----|----|
| 可拖区域 | 顶部 `.card__drag` 区域（top:0, height:20px），含 `DragHandle` pill |
| 拖动形态 | 原生 OS 窗口移动（同胶囊态） |
| 手柄视觉 | `.card__drag` 内 pill 图标，t+470ms 后 opacity 1 可见 |

`.card__body` 区域设为 `no-drag`，避免拖动与对话/输入交互冲突。

### 6.4 锚点哲学（采纳 UX A 反馈 D3）

**决定：展开态拖动保持原生窗口移动（鼠标跟手），无 anchor**。理由：
- 当前行为已经是鼠标跟手（用户拖到哪窗口跟到哪），不存在 B-P2 描述的"右下脚固定"问题。
- `bottom-right` anchor 只在 **resize IPC**（展开/收起）时用，不在拖动时用。
- B-P2 是对代码的误读，归档为"非问题"。

---

## 7. 跨屏规则

### 7.1 展开时的屏幕选择（id:681 已落地）

```typescript
// electron-main/main.ts:112-116
const display = screen.getDisplayMatching({ x, y, width: w, height: h });
const wa = display.workArea; // 含副屏偏移
newX = Math.max(wa.x + 8, Math.min(newX, wa.x + wa.width  - payload.width  - 8));
newY = Math.max(wa.y + 8, Math.min(newY, wa.y + wa.height - payload.height - 8));
```

- `getDisplayMatching` 返回与窗口矩形交集最大的 display。
- `workArea` 已自动排除 taskbar / macOS menu bar / dock（补 UX A 遗漏 M2）。
- Clamp 基于当前 display 的 workArea，8px 安全 padding（平台差异见 §11 P6）。

### 7.2 多屏典型流程

```
初始：主屏 2560×1440 @(0,0) + 副屏 1920×1080 @(2560,0)
胶囊位置：(2140, 1280) 380×120 on 主屏

步骤 1：点展开
  getDisplayMatching → 主屏
  newX = 2140 + 380 - 640 = 1880
  newY = 1280 + 120 - 620 = 780
  clamp → (1880, 780, 640, 620) on 主屏 ✓

步骤 2：拖到副屏 (2800, 400) — 原生窗口移动
  mainWindow 现在在副屏

步骤 3：点 X 收起
  getDisplayMatching((2800, 400, 640, 620)) → 副屏
  newX = 2800 + 640 - 380 = 3060
  newY = 400 + 620 - 120 = 900
  clamp 基于副屏 workArea ✓ 留在副屏
```

### 7.3 遗漏场景补全

#### 7.3.1 展开时超出屏幕 reposition（补 UX A 遗漏 M1）

**场景**：胶囊在主屏 (2500, 1400)，屏幕 2560×1600。展开到 640×620：
- newX = 2500 + 380 - 640 = 2240
- newY = 1400 + 120 - 620 = 900
- clamp: newY 必须 ≤ 1600 - 620 - 8 = 972 → OK
- clamp: newX 必须 ≤ 2560 - 640 - 8 = 1912 → 2240 超出 → 被强 clamp 到 1912

**结论**：窗口右下角不在原位，胶囊右上角"向左滑"进入屏幕。属于预期行为（safety over anchor）。

#### 7.3.2 Taskbar / menu bar 遮挡（补 UX A 遗漏 M2）

`workArea` 已排除 OS chrome，无需额外处理。验证：
- macOS：`workArea.y = 25`（menu bar 高度），`workArea.height = displayHeight - 25 - dockHeight`。
- Windows：`workArea.height = displayHeight - taskbarHeight`。

#### 7.3.3 副屏断开

- Electron 自动把窗口移回主屏。
- React 状态不受影响，下一次 resize IPC 按主屏 clamp。
- 用户可能感知"胶囊突然跳回主屏"。**接受该行为，不做额外处理**。

#### 7.3.4 DPI 跨屏（Retina 200% → 标准 100%）

- Electron setBounds 参数是**逻辑像素**，自动乘以 scale factor。
- 无需代码处理，可能有 1-2px 物理像素偏差（不 pixel-perfect，接受）。

---

## 8. 位置锚点与尺寸

### 8.1 resize 锚点公式（main.ts:108-110）

```typescript
if (payload.anchor === 'bottom-right') {
  newX = x + w - payload.width;
  newY = y + h - payload.height;
}
```

展开 / 收起都用 `bottom-right`，窗口右下角保持原位。

### 8.2 固定尺寸

| 状态 | 宽 | 高 | border-radius |
|------|----|----|---------------|
| CA | 380px | 120px | 44px |
| EXD | 640px | 620px | 20px |

### 8.3 CA 态内部布局

```
[Logo 44×44]       [TitleBlock / badge]          [MenuDots]
 left:18px                                        right:16px
 top:50% (vcenter)
```

### 8.4 EXD 态内部布局

```
┌──────────────────────────────┐
│ [.card__drag 20px]           │  top:0, h:20
├──────────────────────────────┤
│ [logo 28] MTEAM ● … [X]      │  head: top:30, close: top:20 right:14
├──────────────────────────────┤
│                              │
│   .card__body (ExpandedView) │  top:68, bottom:0
│                              │
└──────────────────────────────┘
```

---

## 9. CSS 动画表

### 9.1 opacity 过渡

| 元素 | CA | EXD | transition | 延迟 |
|------|----|----|-----------|------|
| `.card__body` | 0 (pointer-events:none) | 1 (pointer-events:auto) | 200ms ease | 由 JS 在 +350ms 加 class |
| `.card__collapsed` | 1 | 0 + visibility:hidden | 180ms ease + visibility 0s linear 180ms | - |
| `.card__drag` | 0 (pointer-events:none) | 1 (pointer-events:auto) | 150ms ease (→) / 250ms ease 120ms (展开) | 展开延迟 120ms |
| `.card__expanded-head` | 0 | 1 | 150ms ease (→) / 250ms ease 180ms (展开) | 展开延迟 180ms |
| `.card__close` | 0 (pointer-events:none) | 1 (pointer-events:auto) | 150ms ease (→) / 250ms ease 180ms (展开) | 展开延迟 180ms |

### 9.2 位置过渡

| 元素 | CA | EXD | transition |
|------|----|----|-----------|
| `.card` | border-radius:44px | border-radius:20px | 350ms cubic-bezier(0.2,0,0,1) |
| `.card__logo` | left:18px top:50% w:44 h:44 | left:16px top:22px w:28 h:28 | 350ms cubic-bezier(0.2,0,0,1) |

### 9.3 ExpandedView 请求时机（采纳 UX A 反馈 D5）

**决定：`expanded=true` 时立刻发请求，不等 fade 完成**。理由：网络请求耗时 > 350ms 属常态，早发早得，fade 动画期间后台并行加载不影响体感。已由 `CapsulePage.tsx:33` 的 `(expanded || animating) && <ExpandedView />` 保障挂载时机。

---

## 10. 边界情况清单

| # | 场景 | 当前行为 | 风险 | 处理决定 |
|---|------|---------|------|---------|
| B1 | 快速连点 MenuDots/X 10+ 次 | 每轮清 timers，最后一次胜出 | 无 | 保留 |
| B2 | 展开动画中点 X | `.card__close` 已 `pointer-events:auto`，触发打断→收起 | 无 | 保留 |
| B3 | 收起动画中点 MenuDots | `.card__collapsed` 已 `visibility:hidden`，点不到 | 无 | 保留 |
| B4 | 不同 DPI 跨屏 | Electron 自动换算，1-2px 偏差 | 低 | 接受 |
| B5 | 窗口最小化/恢复 | 恢复到最后位置尺寸，toggle 不受影响 | 无 | 保留 |
| B6 | 展开态拖动中点 X | 原生拖动与 React 状态异步，可能 UI 闪烁 | 低 | P3 待观察 |
| B7 | 副屏断开 | Electron 自动移到主屏 | 视觉跳跃 | 接受 |
| B8 | 页面刷新（dev F5） | React 重挂载，回到 URL 参数对应态 | 状态丢失 | P3 持久化（可选） |
| B9 | 展开超出屏幕边缘 | 8px padding clamp，窗口整体内移 | 无 | 保留（见 §7.3.1） |
| B10 | 极端：窗口坐标无效（改分辨率后） | `getDisplayMatching` 返回 closest display，clamp 到合法区域 | 极低 | P4 不做 |
| B11 | DragHandle 无 cursor 视觉 | 默认光标 | UX 小瑕疵 | P3 UX 优化（见 §11 P5） |

---

## 11. 当前代码问题清单

### P1（严重，立即修）

**无**。原 A-P1（多屏跳回主屏）和 B-P4（跨屏展开跳屏）已由 id:681 落地修复；原 A-P1 第二条（展开态拖到副屏后收起错位）经复核，`getDisplayMatching` 在 resize 时用的是**当前窗口位置**（已拖后的新位置），clamp 正确，不存在该问题。

### P2（中等，本期处理）

#### P2-1 快速连击防抖（原 B-P1）

- **现象**：toggle 入口清理 timersRef，但极端 spam 下 React render 频繁。
- **修法**：在 `useCapsuleToggle` 加 `lockedRef: boolean`，toggle 入口检查；在 `setAnimating(false)` 时解锁。
- **文件**：`src/hooks/useCapsuleToggle.ts`
- **验收**：CDP 脚本 20ms 间隔连点 `.btn--dots` × 10 次，最终状态稳定，render 次数 ≤ 3。

#### P2-2 `card--animating` 期间禁点保护（原 A-P2，部分保留）

- **现象**：虽然 CSS 已通过 `.card--expanded .card__collapsed { visibility:hidden }` 保障，但若未来 CSS 变动，缺乏 React 层兜底。
- **修法**：在 `CapsuleCard.tsx`，当 `animating` 为 true 时，给 `.card` 加 `aria-busy="true"` + 在 `.btn--dots` 和 `.card__close` 的 `onClick` 开头判空 `animating` 直接 return。
- **文件**：`src/organisms/CapsuleCard/CapsuleCard.tsx`
- **验收**：动画进行中点对应按钮无反应。**注意**：与打断语义冲突时，以 §5.1 "打断重来" 为准 → 本项实际为**防抖**，与 P2-1 合并实现。

> 结论：P2-1 + P2-2 合并为一个任务。

### P3（低优，按需）

#### P3-1 展开态拖动中点 X 的竞态（原 A-P5 / B-B6）

- **现象**：Electron 原生拖动与 React setState 异步，极端情况 UI 闪烁。
- **修法**：监听 `resize-started` IPC（`main.ts:96` 已发送），在 React 中设 `isDragging`，拖动中 toggle 直接 return。
- **文件**：`src/hooks/useCapsuleToggle.ts`、`electron-main/preload.cjs`
- **验收**：手测拖动 + 快速点 X，无闪烁。

#### P3-2 位置持久化（原 A-P4、A-P6、B-P8）

- **现象**：窗口位置和展开态只存在 Electron BrowserWindow 中，F5 / 重启后丢失。
- **修法**：
  - resize IPC 成功后发新 position 回 renderer，写 `localStorage.capsule.position`。
  - `useCapsuleToggle` 初始化读 `localStorage.capsule.expanded`，优先于 URL 参数。
  - createWindow 时读 localStorage 初始位置。
- **文件**：`electron-main/main.ts`、`electron-main/preload.cjs`、`src/hooks/useCapsuleToggle.ts`
- **验收**：拖到副屏 → 重启 → 胶囊出现在副屏原位。

#### P3-3 DragHandle cursor 反馈（原 B-P7）

- **修法**：`.card__drag` 加 `cursor: grab`，按下时 JS 切 `cursor: grabbing`。
- **文件**：`src/organisms/CapsuleCard/CapsuleCard.css`、`src/molecules/DragHandle/DragHandle.css`
- **验收**：鼠标 hover 拖动区显示 grab，按下显示 grabbing。

#### P3-4 动画时长常量统一（原 B-P6）

- **现象**：`RESIZE_MS=350` / `BODY_FADE_MS=200` 硬编码在 hook，CSS 中的过渡时间独立写。
- **修法**：在 CapsuleCard.css 顶部定义 `:root { --capsule-resize-ms: 350ms; --capsule-fade-ms: 200ms; }`，hook 通过 `getComputedStyle` 读取，或反向把 JS 常量注入 CSS variable。
- **优先级**：P4（可不改）。

### 归档（非问题 / 已落地）

| 原问题 | 结论 |
|--------|-----|
| A-P1 多屏跳回主屏 | 已由 id:681 修复 |
| A-P1 展开态拖副屏收起错位 | 不存在（代码已正确） |
| A-P3 收起动画点击穿透 | CSS 已保障（§10 B3） |
| B-P2 展开态拖动右下脚固定 | 代码误读，拖动不走 anchor |
| B-P3 ExpandedView 渲染完整性 | 已由 id:584 修复 |
| B-P4 跨屏拖动后展开位置校验 | 已由 id:681 修复 |
| B-P5 bodyVisible 命名 | 保留现名 |

---

## 12. 修复方案总览

| 任务 | 优先级 | 涉及文件 | 预估 |
|------|--------|---------|------|
| T1 toggle 防抖 + animating 期间按钮锁 | P2 | `useCapsuleToggle.ts`, `CapsuleCard.tsx` | S |
| T2 拖动中锁定 toggle | P3 | `preload.cjs`, `useCapsuleToggle.ts` | M |
| T3 位置 / 展开态持久化 | P3 | `main.ts`, `preload.cjs`, `useCapsuleToggle.ts` | M |
| T4 DragHandle cursor 反馈 | P3 | `CapsuleCard.css`, `DragHandle.css` | XS |

---

## 13. 开发任务（派单）

下面每个任务都可独立交付，附验证方法。所有 UI 改动必须附 CDP 截图（遵循 `feedback_verify_ui_before_deliver`）。

---

### T1 — toggle 防抖 + animating 期间按钮锁

**描述**  
防止快速连击展开/收起造成 React 多次 render，并在动画进行中锁住按钮点击（与 §5.1 打断语义不冲突：打断发生在动画**完成前**的边界，本任务防的是同一按钮**重复触发**）。

**涉及文件**
- `packages/renderer/src/hooks/useCapsuleToggle.ts`
- `packages/renderer/src/organisms/CapsuleCard/CapsuleCard.tsx`

**修法**
1. `useCapsuleToggle` 增加 `lockedRef = useRef(false)`。
2. `toggle()` 入口：
   ```ts
   if (lockedRef.current) return;
   lockedRef.current = true;
   // ... 原逻辑
   schedule(() => { setAnimating(false); lockedRef.current = false; }, TOTAL_MS);
   ```
3. `CapsuleCard.tsx` 根元素加 `aria-busy={animating}`，便于 CDP 选择器断言。

**验证方法**
- tsc pass。
- CDP 脚本：
  1. 启动 renderer dev，连 CDP。
  2. 连点 `.btn--dots` 10 次（每 20ms 一次），截图 t+0 / t+600ms。
  3. 断言 600ms 后 `expanded === true`、`aria-busy === false`、窗口尺寸 640×620。
  4. 展开稳定后，连点 `.card__close` 10 次（每 20ms），同样断言收起稳定。
- 截图存 `docs/phase2/T1-capsule-debounce-*.png`。

---

### T2 — 拖动中锁定 toggle

**描述**  
利用 `main.ts:96` 已有的 `resize-started` IPC（当前只在 `startResize` 时发，需要改成**所有拖动 / resize 开始**都发），在 renderer 侧监听，拖动期间 `toggle()` 直接 return，避免与 `bottom-right` anchor resize 冲突。

**涉及文件**
- `packages/renderer/electron-main/main.ts`
- `packages/renderer/electron-main/preload.cjs`
- `packages/renderer/src/hooks/useCapsuleToggle.ts`

**修法**
1. `main.ts`：监听 `mainWindow.on('will-move', ...)` 触发 `resize-started`，`mainWindow.on('moved')` 触发 `drag-ended`（dev-only 兜底，macOS 支持）。
2. `preload.cjs` 增加 `onDragStart(cb) / onDragEnd(cb)`。
3. `useCapsuleToggle.ts` 加 `draggingRef`，onDragStart → true，onDragEnd → false；toggle 入口检查。

**验证方法**
- tsc pass。
- 真机手测（CDP 不能模拟拖动）：
  1. 展开胶囊。
  2. 按住 DragHandle 开始拖，拖动中点 X。
  3. 预期：无反应，拖完松开后 X 才可用。
- 截图：拖动前 / 拖动中尝试点 X / 松开后点 X。

---

### T3 — 位置 / 展开态持久化

**描述**  
胶囊位置和展开态写 localStorage，重启恢复，解决 F5 状态丢失 + 副屏拖完重启跳回主屏问题。

**涉及文件**
- `packages/renderer/electron-main/main.ts`
- `packages/renderer/electron-main/preload.cjs`
- `packages/renderer/src/hooks/useCapsuleToggle.ts`

**修法**
1. `useCapsuleToggle`：
   ```ts
   // useEffect 初始化
   const saved = JSON.parse(localStorage.getItem('capsule') || '{}');
   const initiallyExpanded = INITIAL_EXPANDED ?? saved.expanded ?? false;
   // ...
   // toggle 结束时 schedule 写回
   schedule(() => localStorage.setItem('capsule', JSON.stringify({ expanded })), TOTAL_MS);
   ```
2. `preload.cjs` 暴露 `getPosition()` / `setInitialPosition(x, y)`。
3. `main.ts:47-59` createWindow 读取 `saved.x / saved.y`（renderer 通过 query 或 IPC 传）；`mainWindow.on('moved')` 持久化。

**验证方法**
- tsc pass。
- CDP + 手测：
  1. 展开 → 关闭 app → 重启 → 展开态自动恢复。
  2. 拖到屏幕左上 → 关闭 → 重启 → 位置恢复。
- 截图：展开恢复、位置恢复。

---

### T4 — DragHandle cursor 反馈

**描述**  
鼠标悬停拖拽区显示 `grab`，按下显示 `grabbing`。

**涉及文件**
- `packages/renderer/src/organisms/CapsuleCard/CapsuleCard.css`
- `packages/renderer/src/molecules/DragHandle/DragHandle.css`

**修法**
```css
.card__drag { cursor: grab; }
.card__drag:active { cursor: grabbing; }
.card { cursor: default; } /* CA 态不显示 grab */
.card--expanded .card__drag { cursor: grab; } /* EXD 态 drag 区域才有 */
```

**验证方法**
- CDP 截图 hover `.card__drag` + 按下状态。
- tsc / 样式检查。
- 截图：`docs/phase2/T4-drag-cursor-*.png`。

---

## 14. 验证 Checklist（交付时逐条勾）

- [ ] **冷启动 CA**：无 URL 参数启动 → 胶囊态 380×120，右下角位置。
- [ ] **冷启动 EXD**：`?expanded=1` → 展开态 640×620，body 已可见。
- [ ] **展开**：点 MenuDots → 350ms resize + 200ms body fade，无卡顿。
- [ ] **收起**：点 X → 200ms body fade + 350ms resize，无残影。
- [ ] **胶囊态拖动**：拖任意区域（除 MenuDots）→ 原生拖拽跟手。
- [ ] **展开态拖动**：拖 `.card__drag` 顶部 20px → 原生拖拽跟手，body 区域不可拖。
- [ ] **展开态 body 拖不动**：在 ExpandedView 内按住拖动 → 无反应。
- [ ] **快速展开/收起打断**：动画中点对立按钮 → 立刻切向。
- [ ] **快速连击防抖（T1 后）**：spam 点击 10 次 → 稳定收敛。
- [ ] **跨屏展开**：副屏胶囊点展开 → 就地扩展，不跳主屏。
- [ ] **跨屏收起**：副屏展开态点 X → 回缩 380×120，留在副屏。
- [ ] **屏幕边缘 clamp**：拖到屏幕右下角贴边展开 → clamp 到 8px padding。
- [ ] **副屏断开**：拔线 → 窗口自动回主屏（视觉跳跃可接受）。
- [ ] **拖动中锁 X（T2 后）**：拖动中点 X 无反应，松开后恢复。
- [ ] **重启位置恢复（T3 后）**：拖到副屏 → 关闭 app → 重开 → 回到副屏。
- [ ] **cursor 反馈（T4 后）**：拖拽区显示 grab/grabbing。

---

## 15. 相关 mnemo 知识

| ID | 标题 | 状态 |
|----|------|------|
| 584 | CapsuleCard 展开态 opacity=0 P0 修复 | 已落地 |
| 681 | 跨屏展开跳回主屏根因：clamp 用 primaryDisplay | 已落地 |
| 682 | 胶囊交互完整细节清单（设计师 B） | 已合入本文档 |
| 683 | 胶囊交互完整规范 — 状态机 + 时序（设计师 A） | 已合入本文档 |
| 684 | 胶囊交互规范互审反馈（UX A → UX B） | 已合入本文档 |
| 651 | Phase 2 后追加：动画体验优化 + 性能专项 | 本文档属其子项 |

---

## 16. 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-27 | v1 (A) | 设计师 A 初版 |
| 2026-04-27 | v1 (B) | 设计师 B 初版 |
| 2026-04-27 | v2 | **merge-spec 合并为权威版**：状态机统一、代码误读修正（B-P2 / B §5.1）、纳入 UX A 反馈（M1-M3, D1-D5, O1-O2）、P1-P3 重排、开发任务 T1-T4 派单 |
