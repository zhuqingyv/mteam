# 前端聊天界面组件技术方案

> 基于设计图（毛玻璃 + 异形气泡 + 发光边框 + agent 思考过程）与 `packages/renderer` 现状调研产出。
> 对应 phase-ws 的前端接入工作，只谈视觉 + 组件结构，不含 WS 订阅/store 设计（WS 接入另行评审）。

---

## 技术栈现状

| 项 | 版本/值 | 说明 |
|---|---|---|
| React | 19 | 已启用 |
| Tailwind CSS | 4.2（`@tailwindcss/vite`） | 通过 `tailwind.config.ts` 消费 CSS 变量 |
| Zustand | 5.0 | store 按领域拆（`teamStore` / `chatStore` / `uiStore`），目前只是空壳 |
| Electron | 41 | 多窗口，透明背景 |
| 构建 | Vite 6 | 无路由库，单页面直接渲染 |
| 测试 | Playwright（E2E） | 无组件级单测框架 |

### 分层现状（`COMPONENT-ARCHITECTURE.md` 落地情况）

```
src/
├── design-tokens/   tokens.css + tailwind.config.ts（✅ 落地）
├── atoms/           Button / Icon / Logo / StatusDot / Surface / Text
├── molecules/       Avatar / DragHandle / MenuDots / MessageBadge / TitleBlock
├── organisms/       CapsuleCard （仅此一个）
├── templates/       空
├── pages/           空（App.tsx 直接挂 CapsuleCard）
├── store/           chatStore / teamStore / uiStore （均为空壳）
└── api/             client.ts
```

### 关键发现

1. **Surface atom 已实现"发光毛玻璃"**：`Surface.css` 有 `capsule` / `panel` 两个 variant，用 7 层 `box-shadow`（inset + outer）做出发光边缘 + 玻璃感。这是"发光边框"的天然母本。
2. **tokens 已建好**：颜色/间距/圆角/阴影全部走 CSS 变量 + Tailwind theme.extend，直接在 JSX 写 utility class 即可。
3. **聊天相关 organism 完全不存在**：`ChatPanel` 在架构文档里规划了但没落地；当前 `chatStore` 只定义了 `messages: {id, role, content, timestamp}[]`，没有气泡、思考、工具调用的字段。
4. **driver 事件后端已完整**：5 类 `driver.*` 事件（thinking / text / tool_call / tool_result / turn_done）在 bus 里已全量广播（见 mnemo id:419），前端零接入。
5. **已有铁律**：atom 不透传 `className`；跨组件视觉参数必须走 token；复杂效果允许独立 CSS 文件但变量必须来自 token。

---

## 组件清单

| # | 组件名 | 层级 | 职责 | 复用度 | 预估行数 |
|---|---|---|---|---|---|
| 1 | `GlowSurface` | atoms | 发光毛玻璃底座（从 Surface 拆出的变体） | 极高（窗口/气泡/卡片） | ~60 |
| 2 | `MessageBubble` | molecules | 单条消息气泡（左右变体 + 尾巴） | 高（聊天/桌宠） | ~80 |
| 3 | `ReadReceipt` | atoms | 双勾已读标记 | 低（气泡内） | ~20 |
| 4 | `Timestamp` | atoms | 时间戳文本 | 中（气泡/列表） | ~15 |
| 5 | `ThinkingBlock` | molecules | 可折叠思考过程 | 中（聊天/调试面板） | ~90 |
| 6 | `ToolCallCard` | molecules | 工具调用卡（名称 + 参数 + 状态 + 结果） | 中 | ~120 |
| 7 | `StreamText` | atoms | 流式文本渲染（支持 append） | 高（气泡/思考/工具结果） | ~40 |
| 8 | `MessageList` | organisms | 消息列表 + 虚拟滚动 + 自动贴底 | 单处 | ~150 |
| 9 | `Composer` | organisms | 输入框 + 模型选择 + 工具按钮 + 发送 | 单处 | ~120 |
| 10 | `TitleBar` | molecules | 顶部标题栏（logo + 名称 + 在线点 + 关闭） | 单处（现有 Capsule 可复用） | ~40 |
| 11 | `ChatPanel` | organisms | 聊天主体（TitleBar + MessageList + Composer） | 单处 | ~60 |
| 12 | `ChatWindow` | templates | 窗口骨架（GlowSurface + 内容槽） | 单处 | ~30 |
| 13 | `ChatPage` | pages | 入口（绑定 WS / store / 快捷键） | 单处 | ~50 |

合计新增约 **875 行**（含 CSS 文件），复用现有 `Surface` / `Avatar` / `StatusDot` / `Logo` / `Button` 不重复计。

---

## 方案 1：异形对话气泡

### 技术方案

异形 = **非对称圆角** + **小尾巴**。主流 3 种实现：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 伪元素小三角 | `::after` + border 拼三角 | 纯 CSS、最轻 | 三角是实色，毛玻璃下会"破"（缺背景模糊） |
| B. 不对称 border-radius | `border-radius: 18px 18px 18px 4px` 收一个角 | 零成本、和毛玻璃兼容 | 没有"尾巴"形状 |
| C. SVG mask / clip-path | `clip-path: path(...)` 画异形 | 自由形状 | path 难维护；毛玻璃需要 `backdrop-filter`，clip 后边缘会锯齿 |

**采用方案 B（不对称圆角）+ 头像粘连**。原因：
- 设计图里左侧气泡与 M 头像紧贴，**头像本身就是"尾巴"的语义**，不需要画尖角。
- 毛玻璃 `backdrop-filter` 对三角形支持差（A 方案的三角底色是硬色，玻璃感直接破）。
- 不对称圆角 + 现有 `GlowSurface` 的发光边 = 气泡直接继承窗口统一视觉。

### 代码示例

```tsx
// molecules/MessageBubble/MessageBubble.tsx
interface Props {
  role: 'agent' | 'user';
  content: ReactNode;
  timestamp: number;
  read?: boolean;     // 仅 user 气泡
}

export default function MessageBubble({ role, content, timestamp, read }: Props) {
  return (
    <div className={`bubble bubble--${role}`}>
      <div className="bubble__body">{content}</div>
      <div className="bubble__meta">
        <Timestamp value={timestamp} />
        {role === 'user' && <ReadReceipt read={read} />}
      </div>
    </div>
  );
}
```

```css
/* MessageBubble.css —— 仅列关键部分 */
.bubble {
  max-width: 78%;
  padding: 10px 14px 6px;
  font-size: var(--font-size-md);
  line-height: 1.45;
  position: relative;
  backdrop-filter: blur(20px) saturate(140%);
}

/* 左侧 agent：左下尖角（贴头像） */
.bubble--agent {
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text-primary);
  align-self: flex-start;
  margin-left: 8px;   /* 头像在左外侧 */
}

/* 右侧 user：右下尖角 */
.bubble--user {
  border-radius: var(--radius-lg) var(--radius-lg) 4px var(--radius-lg);
  background: linear-gradient(
    135deg,
    rgba(74, 163, 255, 0.95) 0%,
    rgba(52, 120, 220, 0.95) 100%
  );
  color: #fff;
  align-self: flex-end;
}

.bubble__meta {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  font-size: var(--font-size-xs);
  opacity: 0.6;
  margin-top: 4px;
}
```

### 列表项渲染

```tsx
// organisms/MessageList/MessageList.tsx
<ul className="msg-list">
  {messages.map((m) => (
    <li key={m.id} className={`msg msg--${m.role}`}>
      {m.role === 'agent' && <Avatar size={32} />}
      <div className="msg__col">
        {m.thinking && <ThinkingBlock content={m.thinking} />}
        {m.toolCalls?.map((tc) => <ToolCallCard key={tc.id} {...tc} />)}
        <MessageBubble role={m.role} content={m.text} timestamp={m.ts} read={m.read} />
      </div>
    </li>
  ))}
</ul>
```

```css
.msg { display: flex; gap: 8px; margin: 8px 16px; }
.msg--agent { justify-content: flex-start; }
.msg--user  { justify-content: flex-end; }
.msg__col   { display: flex; flex-direction: column; max-width: 78%; }
```

### 气泡 props 约定（照 §7 铁律）

- `role: 'agent' | 'user'` —— 枚举，不用 `isAgent`
- `read: boolean` —— 直接名词，无 `isRead`
- 不透传 `className` —— atom 零开天窗
- `onXxx` 前缀 —— `onRetry?`、`onCopy?`（备用）

---

## 方案 2：agent 思考过程展示

### 事件 → UI 映射

| driver 事件 | UI 呈现 | 交互 |
|---|---|---|
| `driver.thinking` | `ThinkingBlock` 灰色斜体块 | 默认**折叠**，点击展开；流式追加 |
| `driver.tool_call` | `ToolCallCard` 卡片（工具名 + 参数 JSON） | 默认**折叠参数**，状态=pending 时转圈 |
| `driver.tool_result` | 更新对应 `ToolCallCard` 的 `result` + `ok`，状态改 done/failed | 失败时红边；长结果折叠 |
| `driver.text` | 追加到当前 `MessageBubble.content` | 流式，逐段追加文本节点 |
| `driver.turn_done` | 本轮 agent message 标记 done，隐藏 loading 光标 | 切回 idle |
| `driver.error` | 在气泡外插入错误行（复用 `MessageBubble` 的 danger variant） | 可点"重试" |

### 组件设计

#### ThinkingBlock

```tsx
interface Props {
  content: string;      // 流式追加
  done?: boolean;       // 本段思考是否已结束
  defaultOpen?: boolean;
}
```

- 默认折叠，表头显示"思考中…"或"已思考（3.2s）"
- 展开后内部是 `StreamText`，灰色 12px 斜体
- `done=false` 时头部带呼吸光点动画
- CSS：左侧 2px 竖条（accent-primary 低透明度），右侧文本；圆角与气泡一致

#### ToolCallCard

```tsx
interface Props {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'done' | 'failed';
  output?: unknown;     // pending 时为 undefined
}
```

视觉：
- 标题行：`[工具图标] name` + 状态点（pending=转圈、done=绿勾、failed=红叉）
- 参数区：默认折叠，展开显示 JSON（`<pre>` + 单色语法着色）
- 结果区：`status='done'` 时展示，超过 10 行折叠；`failed` 时红色
- 宽度对齐气泡宽度（`max-width: 78%`）

#### StreamText

```tsx
interface Props {
  text: string;         // 外部持有完整文本，每次 re-render 传入最新值
  cursor?: boolean;     // 是否显示流式光标
}
```

- 实现：`<span>{text}</span>{cursor && <span className="cursor" />}`
- 不需要自己管增量——上层 store 拼好完整字符串就行
- 光标是 CSS `@keyframes blink` 的小竖条

### 流式渲染策略

**核心原则：state 只存完整字符串，不做 char-by-char 动画。**

| 场景 | 做法 | 性能保障 |
|---|---|---|
| 文本追加（driver.text） | store 里 `content += chunk`，React re-render 整条消息 | React 19 自动批处理；大段文本用 `useDeferredValue` 降优先级 |
| 思考流（driver.thinking） | 同上，同样整段 re-render | 思考块默认折叠，不在 DOM 里 |
| 工具调用 | 每个 ToolCallCard 独立 key，只有状态变化时 re-render 对应卡 | 消息粒度 key，兄弟卡不动 |
| 历史消息滚动 | `MessageList` 加 `overflow-y: auto` + `content-visibility: auto` | 浏览器级离屏优化，不上虚拟列表（1000 条内够用） |
| 贴底 | 新消息到来时若用户滚在底部才自动贴底；否则显示"N 条新消息"浮标 | 避免"用户翻旧消息被冲走"体感问题 |

**不做的事**（过度工程）：
- 不自己实现逐字动画（浪费 CPU）
- 不上 react-window / react-virtuoso（1000 条内 DOM 扛得住）
- 不用 requestAnimationFrame 节流 setState（React 19 已经批）

**DOM 更新热点防御**：
- `MessageBubble` 用 `React.memo`，props 不变不 re-render
- `StreamText` 用 `React.memo`，`text` 引用相同则跳过

---

## 方案 3：发光边框通用组件

### CSS 方案

设计图中"发光"= **inset 高光 + outer 光晕**。现有 `Surface.css` 已实现完整配方：

```css
.glow {
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: linear-gradient(
    135deg,
    rgba(40, 44, 56, 0.55) 0%,
    rgba(28, 30, 38, 0.6) 100%
  );
  backdrop-filter: blur(50px) saturate(150%);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.3),       /* 顶部高光 */
    inset 0 -1px 2px rgba(0, 0, 0, 0.25),           /* 底部阴影 */
    inset 0 0 18px var(--glow-tint-inner-soft),     /* 内发光近 */
    inset 0 0 40px var(--glow-tint-inner-deep),     /* 内发光远 */
    0 0 6px  var(--glow-tint-outer-close),          /* 外光晕近 */
    0 0 16px var(--glow-tint-outer-mid),            /* 外光晕中 */
    0 0 30px var(--glow-tint-outer-far);            /* 外光晕远 */
}
```

**通用化做法**：把 7 层阴影抽成 `--glow-*` 变量组，`color` prop 切换变量值即可换色。

### 组件 API

```tsx
// atoms/GlowSurface/GlowSurface.tsx
interface Props {
  color?: 'neutral' | 'success' | 'warning' | 'danger' | 'primary';
  intensity?: 'soft' | 'normal' | 'strong';
  radius?: 'md' | 'lg' | 'xl' | 'pill';
  interactive?: boolean;   // true 时 hover 增强光晕 + 轻微上浮
  children: ReactNode;
}
```

- 不接 `className` / `style`（铁律）
- `color` / `intensity` / `radius` 全是枚举，不放任意数值
- `interactive` 是 boolean 直名

### 状态变色

```css
/* tokens.css 新增 */
:root {
  /* 默认（冷白） */
  --glow-neutral-inner-soft: rgba(180, 190, 220, 0.28);
  --glow-neutral-inner-deep: rgba(150, 160, 200, 0.15);
  --glow-neutral-outer-close: rgba(160, 170, 200, 0.30);
  --glow-neutral-outer-mid:   rgba(140, 150, 180, 0.20);
  --glow-neutral-outer-far:   rgba(120, 130, 170, 0.12);

  /* 在线绿 */
  --glow-success-inner-soft: rgba(100, 220, 140, 0.32);
  --glow-success-inner-deep: rgba(80, 200, 120, 0.18);
  --glow-success-outer-close: rgba(80, 210, 130, 0.30);
  --glow-success-outer-mid:   rgba(60, 190, 110, 0.18);
  --glow-success-outer-far:   rgba(40, 170, 90, 0.10);

  /* 繁忙黄、错误红同理，省略 */
}
```

```css
.glow--success { /* 7 层阴影全换成 --glow-success-* */ }
.glow--danger  { /* 同理 */ }
```

### 性能评估

| 点 | 风险 | 对策 |
|---|---|---|
| 7 层 `box-shadow` 重绘成本 | 滚动/hover 时 CPU 占用 | 外层 `will-change: box-shadow` + `transform: translateZ(0)` 上 GPU 合成 |
| `backdrop-filter: blur(50px)` | 低端显卡掉帧 | 已在 Surface 用，线上跑过；blur 值不放到气泡级（只在窗口外层一处） |
| 气泡数量多时每个都有 glow | 100 条 × 7 阴影 = 700 层 paint | **气泡不使用 `GlowSurface`**，只有窗口 + TitleBar + ToolCallCard 用；气泡是半透明背景，没有发光边 |
| hover 态光晕增强 | 每帧 relayout | 只改 `box-shadow`，不改 size；`transition` 走 `transform + box-shadow` |

### 使用边界

| 用 GlowSurface | 不用 |
|---|---|
| 窗口最外层（ChatWindow） | 消息气泡（太多，成本爆炸） |
| 胶囊（CapsuleCard 现有） | 纯文本标签 |
| 状态卡片（如 AgentStatusCard） | 列表行 |
| ToolCallCard（强调"正在工作"） | ThinkingBlock（灰色简约足够） |

---

## 完整组件树

```
ChatPage                              [pages]
└── ChatWindow                        [templates]
    └── GlowSurface color=neutral     [atoms]  ← 窗口外发光
        ├── TitleBar                  [molecules]
        │   ├── Avatar online         [molecules] (已存在)
        │   ├── Text "MTEAM"          [atoms] (已存在)
        │   ├── StatusDot online      [atoms] (已存在)
        │   └── Button variant=icon   [atoms] (已存在)
        │
        ├── ChatPanel                 [organisms]
        │   └── MessageList           [organisms]
        │       └── li.msg (循环)
        │           ├── Avatar (仅 agent)
        │           └── msg__col
        │               ├── ThinkingBlock     [molecules]
        │               │   └── StreamText    [atoms]
        │               ├── ToolCallCard (×N) [molecules]
        │               │   ├── GlowSurface color=primary intensity=soft
        │               │   ├── StatusDot (pending/done/failed)
        │               │   └── <pre> 参数/结果
        │               └── MessageBubble     [molecules]
        │                   ├── StreamText    [atoms]
        │                   ├── Timestamp     [atoms]
        │                   └── ReadReceipt   [atoms] (仅 user)
        │
        └── Composer                  [organisms]
            ├── ModelSelector         [molecules]   (下拉)
            ├── Button variant=icon   [atoms]       (工具)
            ├── <textarea>            (原生)
            └── Button variant=primary (发送)
```

---

## 工作量估算

按"一人一天 ≈ 200 行可用代码 + 测试"粗估：

| 阶段 | 组件 | 行数 | 人日 |
|---|---|---|---|
| P0 基础设施 | GlowSurface 拆出 + tokens 扩展（--glow-* 多色） | 100 | 0.5 |
| P1 原子 | StreamText / Timestamp / ReadReceipt | 75 | 0.4 |
| P2 气泡 | MessageBubble + 左右样式 + Avatar 粘连布局 | 130 | 0.8 |
| P3 思考区 | ThinkingBlock（折叠 + 流式） | 90 | 0.6 |
| P4 工具卡 | ToolCallCard（参数/结果 + 状态） | 120 | 0.8 |
| P5 列表 | MessageList（贴底 + 新消息浮标） | 150 | 1.0 |
| P6 输入栏 | Composer（选择器 + 输入 + 发送 + 快捷键） | 120 | 0.8 |
| P7 标题栏 + 窗口 | TitleBar + ChatWindow + ChatPage | 120 | 0.6 |
| P8 联调 | 接 chatStore、绑 WS 事件（本次不做，phase-ws 主线负责） | — | — |
| **合计** | | **~905 行** | **~5.5 人日** |

**风险点**：
1. `backdrop-filter` 在 Electron 透明窗口 + 多层嵌套可能出现渲染异常（需真机验证，现有 CapsuleCard 跑通过说明基线 OK）。
2. 流式文本性能在超长 turn（>10KB 文本）下可能卡顿，应先按"整段 re-render"最简方案上线，有数据再优化。
3. ToolCallCard 结果展示如果含表格/markdown 会复杂化，**本期只支持纯文本 + JSON**，markdown 留后续迭代。

**不做的事**（明确排除，避免 scope 蔓延）：
- 虚拟滚动库（react-window 等）—— 无数据支撑
- 代码高亮库（prism / shiki）—— JSON 单色够用
- 消息搜索 / 筛选 —— phase-ws 主线不涉及
- 桌宠气泡复用 MessageBubble —— 等第二次使用场景出现再抽（§10 原则）
