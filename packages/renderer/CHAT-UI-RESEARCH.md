# 聊天界面组件方案调研

> 对应设计：`~/.claude/image-cache/fe74fff4-db0c-4f7f-8675-9cd440531a25/26.png`
> 适用范围：`packages/renderer`，组合进 `organisms/ChatPanel`
> 读者：落地聊天窗口的执行 agent

---

## 0. 设计图要点复述（用于对齐）

- 毛玻璃暗色面板，整体圆角、微发光边。
- 顶栏：左侧小 Logo + `MTEAM` 标题 + 绿色在线点；右侧 `×` 关闭。
- 消息区：
  - 左 agent 消息：带 Logo 头像、毛玻璃暗色气泡、**左下角尖角指向头像**，气泡下方时间戳。
  - 右用户消息：蓝色半透明气泡、**右下角尖角**、时间戳 + 双勾已读。
  - 内容混排：纯文本 / bullet list / emoji。
  - 所有气泡都有一圈淡发光边。
- 思考态：agent 气泡内 "正在思考 ···"，三点循环动画。
- 底栏：Agent 切换（Claude + 下拉箭头）+ 快捷操作图标 + 圆角输入框 + 蓝色圆形发送按钮。

---

## 1. 现状盘点（决定抽象粒度的前提）

已有 atoms：`Icon / Text / StatusDot / Logo / Button / Surface`
已有 molecules：`Avatar / TitleBlock / MenuDots / MessageBadge / DragHandle`

关键现状约束：

1. **`Surface` 目前耦合拖拽**：`Surface.css` 里硬编码 `-webkit-app-region: drag`，并且 variant 只有 `capsule | panel`。聊天气泡不能直接复用它的现有 variant，否则整个气泡会被当成窗口拖拽区。
2. **`Avatar` 目前硬绑定 `Logo`**：`Avatar.tsx` 内部直接 `<Logo />`，没有走图片/图标三态。聊天场景里用户头像不一定是 M Logo，需要小调整。
3. **`StatusDot`** 可直接复用（顶栏绿点、已读勾的小配件不一样，已读用单独组件更合适）。
4. **`Text`** 已具备 variant/tone，用于气泡文本、时间戳、占位文案足够。
5. **Token 体系**已覆盖玻璃色、文字层级、发光阴影的基础材料，聊天气泡的发光效果应从 token 扩展，而不是各组件各写一套。

> 铁律：**不要顺手改 Surface 的 drag 行为**，这会波及胶囊窗口。应用在 `Surface` 里新增 `tone` 或新增兄弟 atom，见下文 Q3。

---

## 2. Q1：异形对话框气泡如何实现？

### 2.1 方案对比

| 方案 | 圆角 + 发光 | 尖角与气泡同色/同毛玻璃 | 可响应背景 | 代码复杂度 | 评价 |
|---|---|---|---|---|---|
| A. `::before` / `::after` 伪元素（旋转方块 45°） | 圆角易，发光边**在尖角处会断裂** | 尖角是独立方块，`backdrop-filter` 会**单独采样一次模糊**，透过去的底图与本体对不齐 | 一般 | 低 | ❌ 毛玻璃场景对不齐，边框发光缝线明显 |
| B. SVG path（整体一次画完） | 圆角 + 尖角都可自由控制 | 可做但 `backdrop-filter` 在 SVG 上支持差，需要 `foreignObject` 兜底 | 好 | 中高 | 面板超小时可考虑，聊天量大不划算 |
| C. `clip-path` 裁切（polygon / path） | 裁切后**圆角必须自己算**、**`box-shadow` 会被裁掉** | 同体同色 | 好 | 中 | 发光边靠 `filter: drop-shadow` 兜底，相对可行 |
| **D. 单节点 `border-radius` + 一个 SVG 尾巴（推荐）** | 圆角用 CSS `border-radius`，**发光边和毛玻璃都作用在本体** | 尾巴用独立 SVG，贴在气泡左下/右下外沿；SVG 的 `fill` 使用**同一组 CSS 变量**，靠设计色让肉眼对不齐的微差可接受 | 好 | 中 | ✅ 实现成本低、视觉一致性够、后续换 token 统一生效 |

### 2.2 推荐：方案 D（本体 CSS 圆角 + 外挂 SVG 尾巴）

关键点：

- **气泡本体**：普通 `div`，圆角、毛玻璃、发光边都由 CSS 处理（复用 token）。
- **尾巴**：独立 `<svg>` 绝对定位在气泡外沿，只画一个带圆角的小三角 path，`fill` 用和气泡本体**同一个半透明色变量**；发光边**不延伸到尾巴上**，尾巴只负责"指向"。
- **为什么可以不接发光边**：设计图里尾巴很小，人眼主要感受到的是主体的发光轮廓，小尾巴哑一点反而不显眼。

### 2.3 骨架（不落代码，仅示意结构）

```tsx
// molecules/MessageBubble/MessageBubble.tsx
interface MessageBubbleProps {
  side: 'left' | 'right';        // agent vs user
  tone: 'glass-dark' | 'accent'; // 左暗玻璃，右蓝色
  children: ReactNode;
}
// 结构：
// <div class="bubble bubble--{side} bubble--{tone}">
//   <div class="bubble__content">{children}</div>
//   <BubbleTail side={side} tone={tone} />   // 独立 SVG atom
// </div>
```

```css
/* bubble 本体 */
.bubble {
  position: relative;
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  max-width: 78%;
  backdrop-filter: blur(24px) saturate(140%);
  border: 1px solid rgba(255,255,255,0.10);
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.06),
    0 0 12px rgba(160,170,200,0.18),
    0 8px 24px rgba(0,0,0,0.28);
}
.bubble--glass-dark { background: var(--surface-glass-dark); }
.bubble--accent     { background: var(--bubble-accent-fill); /* 新增 token */ }

/* 尾巴通过绝对定位贴到外沿；SVG 内部自带尖角 path */
.bubble__tail { position: absolute; bottom: -6px; }
.bubble--left  .bubble__tail { left:  -6px; }
.bubble--right .bubble__tail { right: -6px; transform: scaleX(-1); }
```

**不推荐**：不要为了"尾巴也毛玻璃"去做 `clip-path` 整体裁切，这会导致你丢 `box-shadow` 发光边，回报极低、代价明显。

---

## 3. Q2：如何展示 agent 的思考过程？

### 3.1 两段式状态

| 阶段 | 数据信号 | UI 呈现 |
|---|---|---|
| thinking | `status: 'thinking'`，content 为空 | 只显示"正在思考 · · ·"，三点跳动动画 |
| streaming | `status: 'streaming'`，content 增量追加 | 正常气泡 + 光标/波纹指示仍在写 |
| done | `status: 'done'` | 普通气泡，无指示 |

这是**同一个 `MessageBubble` 的三种内态**，不要拆成三个组件，否则切换态时会整块换 DOM、抖动。推荐做法：`MessageBubble` 接 `status` prop，在内部切换 children。

### 3.2 三点跳动动画（纯 CSS）

```css
@keyframes dot-bounce {
  0%, 80%, 100% { transform: translateY(0);    opacity: 0.45; }
  40%           { transform: translateY(-3px); opacity: 1; }
}
.thinking__dot {
  width: 4px; height: 4px; border-radius: 999px;
  background: var(--color-text-secondary);
  animation: dot-bounce 1.2s var(--easing-standard) infinite;
}
.thinking__dot:nth-child(2) { animation-delay: 160ms; }
.thinking__dot:nth-child(3) { animation-delay: 320ms; }
```

封装为 `atoms/TypingDots`（职责单一：就画三个会跳的点；不关心文案）。
`molecules/ThinkingIndicator = Text("正在思考") + TypingDots`。

### 3.3 流式渲染（streaming）

- **数据层**：`chatStore` 里每条消息是 `{ id, role, status, content }`；collector 每次拿到增量就 `content += delta`。
- **渲染层**：`MessageBubble` 里的文本用一个支持可变 children 的 `Text` 即可，React diff 只改文本节点。
- **CRLF / Markdown**：初期只做 `\n` 转 `<br/>` + bullet `- xxx` 的简单正则，**不要**上 react-markdown，性能和包体都重；真正 markdown 再迭代。
- **光标指示**：streaming 末尾追加一个 `<span class="caret">` 做 `blink` 动画表示仍在写，比全局 spinner 更克制。

**不推荐**：不要把"思考内容"和"最终回答"做成两块分别淡入淡出，会打乱 agent 回答节奏，也不符合设计图的极简调性。

---

## 4. Q3：发光边框能否抽成通用组件？

### 4.1 现状对比

| 位置 | 需要的玻璃调性 | 当前来源 |
|---|---|---|
| 顶栏、面板整体 | 中等毛玻璃 + 较重外阴影 | `Surface.surface--panel`（含 drag） |
| 消息气泡（左/右） | 薄毛玻璃 + 轻发光边 | 无，本次要新增 |
| 输入框 | 薄毛玻璃 + 柔光内描边 | 无 |
| Agent 切换器 / 发送按钮底 | 最轻一层 | 无 |

共同抽象：**一圈从 `tokens` 取色的淡发光边 + 1px 半透明描边 + 可选毛玻璃背景**。

### 4.2 方案选择

| 方案 | 评价 |
|---|---|
| A. 新建 `atoms/GlowBorder`，作为视觉外壳组件包住 children | ❌ 多套一层 DOM，组合时容易出现圆角不继承、padding 算错，落地成本大于收益 |
| **B. 扩展 `Surface` 的 variant，并拆掉 drag 耦合（推荐）** | ✅ 沿用现有抽象，Surface 本来就是"玻璃/卡片底座"的定位，改动成本最小 |
| C. 纯 Tailwind utility 组合 | ❌ 多层 `box-shadow` + `backdrop-filter` 写成 utility 不可读，token 改动无法全量生效 |

### 4.3 推荐落地：重构 Surface

**关键动作**：

1. 把 `Surface.css` 里的 `-webkit-app-region: drag` **移出 Surface**。drag 区交给 template 层（`PanelWindow`）或专用的 `DragRegion` 组件，原子不应携带窗口语义。
2. `Surface.variant` 扩展为：`capsule | panel | bubble-glass | bubble-accent | input | chip`。每个 variant 只管自己的玻璃色、发光参数，不再偷偷带业务行为。
3. 在 `tokens.css` 新增：
   - `--glow-soft / --glow-medium / --glow-strong`：三档发光 box-shadow 组合，供 Surface 各 variant 取。
   - `--bubble-accent-fill`：用户气泡蓝色底。
   - `--stroke-hairline`：1px 半透明描边色，所有玻璃面通用。
4. hover 抬起效果（当前写在 `.surface--capsule:hover`）只保留给"可点击卡片"的 variant，聊天气泡不抖。

这样所有"发光玻璃面"的视觉一致性由 token + Surface variant 共同保证，下次再有新玻璃面，只加 token + variant，不用到处写 `box-shadow`。

> 迁移注意：现有 `CapsuleCard` 依赖 Surface 的 drag 行为，迁移时需把 drag 移到 Capsule 的 template 层。此项属于 §3 之外的额外工作量，建议**单独开一个小 PR 先拆 drag**，再在本期聊天窗口中消费扩展后的 variant。

---

## 5. 组件清单（按原子设计）

### 5.1 atoms

| 名称 | 状态 | 职责 | 关键 props | CSS 难点 |
|---|---|---|---|---|
| `BubbleTail` | 新建 | 渲染气泡外沿那一个小尖角（SVG） | `side: 'left' \| 'right'`，`tone: 'glass-dark' \| 'accent'` | fill 必须与气泡本体同色 token；尺寸固定避免位移抖动 |
| `TypingDots` | 新建 | 三点跳动动画 | `size?: 'sm' \| 'md'` | `@keyframes` 交错延迟，不要用 JS setInterval |
| `ReadReceipt` | 新建 | 双勾已读图标（可用 Icon 内置也可独立原子） | `state: 'sent' \| 'delivered' \| 'read'` | 蓝勾/灰勾色切换，单个 SVG |
| `IconButton` | 复用 | 走现有 `Button.variant='icon'` | — | — |
| `Surface` | 重构 | 见 §4.3，扩展 variant + 拆 drag | 新增 variant：`bubble-glass` / `bubble-accent` / `input` / `chip` | 多层 box-shadow 走 token，不硬编码 |
| `Text` / `StatusDot` / `Icon` / `Logo` / `Button` | 复用 | — | — | — |

> 不新建 `GlowBorder`：抽象收益低于改 `Surface`。若后续真的需要"给非 Surface 元素包一圈光"，再单起原子。

### 5.2 molecules

| 名称 | 组成 | 职责 | 关键 props | CSS 难点 |
|---|---|---|---|---|
| `MessageBubble` | Surface(bubble-*) + BubbleTail + children slot | 一条消息的气泡壳，不关心具体内容 | `side: 'left' \| 'right'`，`tone: 'glass-dark' \| 'accent'`，`status: 'thinking' \| 'streaming' \| 'done'` | 尾巴与本体色对齐；max-width 78% 限宽 |
| `MessageMeta` | Text(caption) + ReadReceipt? | 时间戳 + 已读双勾 | `timestamp: string`，`receipt?: ReadReceipt 状态` | 时间戳与双勾的基线对齐 |
| `ThinkingIndicator` | Text + TypingDots | "正在思考 ···" | `label?: string`（默认"正在思考"） | 点跳动不要带动文字抖动 |
| `AgentSwitcher` | Avatar 缩小版 + Text + Icon(chevron) | 底栏左侧 agent 选择入口 | `agentName`, `onClick` | 作为按钮的触发区和 agent 头像对齐 |
| `ChatInput` | Surface(input) + textarea + IconButton(send) | 输入框本体 + 发送按钮 | `value`, `onChange`, `onSend`, `placeholder`, `disabled` | 多行高度自增、上下 padding 与 Send 圆按钮视觉对齐；IME 合成期不触发 send |
| `MessageListItem` | Avatar + MessageBubble + MessageMeta | 一行完整的消息布局（左右成镜像） | `side`, `avatar?`, `bubble`, `meta` | 左右两种排布尽量共用 CSS flex-direction |
| `Avatar` | 小改 | 支持聊天场景的用户头像（图片/Logo/首字母三态） | 新增 `variant: 'logo' \| 'image' \| 'initial'` | 不破坏胶囊窗口现有调用 |

> `MessageBadge` 已有，暂不在聊天主面板复用（用于未读计数），保持原样。

### 5.3 organisms

**`organisms/ChatPanel/ChatPanel.tsx`**

职责：完整的聊天窗口主体。

组织结构：

```
ChatPanel
├── ChatHeader           (左: Logo + Title + StatusDot；右: Button(icon, ×))
├── MessageList          (滚动容器，纵向列出 MessageListItem；底端 ThinkingIndicator)
└── ChatFooter
    ├── AgentSwitcher
    ├── QuickActions     (一行 IconButton，数据驱动)
    └── ChatInput
```

关键 props：

| prop | 类型 | 说明 |
|---|---|---|
| `messages` | `ChatMessage[]` | 来自 `chatStore`，含 id/role/status/content/timestamp/receipt |
| `thinking` | `boolean` | 当前 agent 是否在思考（末尾挂 ThinkingIndicator） |
| `currentAgent` | `{ id; name; icon }` | AgentSwitcher 展示 |
| `onSend` | `(text: string) => void` | 发送回调 |
| `onSwitchAgent` | `() => void` | 点击切换器时触发（打开下拉由上层管理） |
| `onClose` | `() => void` | 顶栏关闭按钮 |

实现要点：

1. **滚动策略**：新消息时自动滚到底；用户向上翻阅时不强拉——用"距底 < 120px 才自动跟随"的判定，避免打断阅读。
2. **流式更新性能**：`MessageList` 应以 `message.id` 为 key，仅末尾 streaming 消息重渲染；不要整列 re-render。
3. **键盘**：Enter 发送，Shift+Enter 换行；IME `compositionstart/end` 期间不触发发送（输入中文最常见的坑）。
4. **空状态**：没有消息时给一条占位（不在本期优先级内，但留 slot）。
5. **组件边界**：ChatPanel 只消费 molecule；不要直接写 bubble CSS / tail SVG / dot 动画，全部走下层。

### 5.4 templates 层

本期**不新建** template。聊天窗口可复用 `PanelWindow`，ChatPanel 作为其 content slot 的唯一 organism。如果后续发现窗口级 chrome（托盘、标题栏、窗口按钮）与面板有差异，再考虑 `ChatWindow` 模板。

---

## 6. 实施顺序建议（给执行 agent）

1. **先拆 Surface 的 drag 耦合（独立 PR）** —— 为 bubble / input variant 让路，不改视觉。
2. **扩展 tokens** —— 加 `--glow-*`、`--bubble-accent-fill`、`--stroke-hairline`。
3. **落 atoms**：`BubbleTail`、`TypingDots`、`ReadReceipt`；`Surface` 加 variant。
4. **落 molecules**：`MessageBubble`、`MessageMeta`、`ThinkingIndicator`、`AgentSwitcher`、`ChatInput`、`MessageListItem`；`Avatar` 加 variant。
5. **组装 organism**：`ChatPanel`，先接假数据，再接 `chatStore`。
6. **性能 / IME / 滚动策略** 三项必测，缺一条不能判交付。

---

## 7. 明确不做的事（防过度设计）

- **不做** `GlowBorder` 独立原子；靠 Surface variant 解决。
- **不做** SVG 整体气泡裁切；尾巴独立。
- **不上** react-markdown；初期正则即可。
- **不引入** 虚拟滚动；消息量级到 500 条再评估。
- **不拆** `ChatWindow` template；复用 `PanelWindow`。
- **不顺手重构** 现有 `Avatar` 全部调用点；只新增 variant 保留默认行为。

---

## 8. 结论

- **Q1 异形气泡**：推荐 "CSS 圆角本体 + 独立 SVG 尾巴"（方案 D），综合视觉与实现成本最优。
- **Q2 思考过程**：`MessageBubble` 内部三态切换（thinking / streaming / done），配一个 `atoms/TypingDots` + `molecules/ThinkingIndicator` 组合，不额外拆组件。
- **Q3 发光边框**：不单独做 `GlowBorder`，改走"Surface variant + token 新增"的路径；前置动作是拆掉 Surface 与窗口 drag 的耦合。

新增 atoms 共 3 个（BubbleTail / TypingDots / ReadReceipt），新增 molecules 共 6 个（MessageBubble / MessageMeta / ThinkingIndicator / AgentSwitcher / ChatInput / MessageListItem），新增 organism 1 个（ChatPanel）。Surface 与 Avatar 各需小幅扩展，不破坏现有调用。

报告路径：`/Users/zhuqingyu/project/mcp-team-hub/packages/renderer/CHAT-UI-RESEARCH.md`
