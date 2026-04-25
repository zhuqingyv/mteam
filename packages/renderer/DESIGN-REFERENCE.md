# 设计稿视觉决策清单

> 任务 #10 产出。前端执行时对照本文件，不用反复去翻原图。
> 设计稿目录：`~/.claude/image-cache/fe74fff4-db0c-4f7f-8675-9cd440531a25/`
>
> **原任务指派路径 `26.png` 不存在**（目录里只有 31~43）。下面逐张列出实际可用的设计稿与其产品含义。

---

## 0. 文件清单与定位

| 文件 | 内容 | 对应前端层 |
|---|---|---|
| `31.png` | 胶囊主态（团队名 + 数据 + 未读 + 菜单点） | organism / `CapsuleCard` |
| `32.png` | 手绘草图：单胶囊 → 多窗口层叠的产品演化示意 | 产品形态决策（多窗口） |
| `33.png` | 胶囊主态成片（与 31 相似，更亮） | organism / `CapsuleCard` |
| `34.png` | 品牌 M Logo 光滑玻璃质感 | atom / `Logo` |
| `35.png` | 胶囊（小尺寸变体） | organism / `CapsuleCard` |
| `36.png` | 手绘草图：同 32（另一份） | — |
| `37.png` | Surface 原子的 Storybook 样式（variant 下拉） | 设计系统约定 |
| `38.png` | 胶囊主态（与 31 几乎一致） | organism / `CapsuleCard` |
| `39.png` | **Agent 思考态小框**（头像 + agent 名 + 三点动画 + 浅玻璃小气泡） | molecule / `ThinkingIndicator` |
| `40.png` | **完整聊天面板**（顶栏 + 消息区 + Agent tab + 输入框） | organism / `ChatPanel` |
| `41.png` | 胶囊主态（变体） | organism / `CapsuleCard` |
| `42.png` | **服务端缺失文档表**（PM 自用的缺口清单图） | 项目管理（非 UI） |
| `43.png` | M Logo 大图（设计素材） | atom / `Logo` |

---

## 1. 胶囊主态（31 / 33 / 35 / 38 / 41）

**视觉构成**（从左到右）：
1. 品牌 M Logo（含绿色在线点 `StatusDot`），约 40px
2. TitleBlock：
   - 主标题 `M-TEAM`（字号约 15px，semibold，白 92%）
   - 副文 `3 Agents · 2 Tasks`（字号约 12-13px，白 60%）
   - 第三行 `5 New messages` + 蓝点 `MessageBadge`（蓝色 dot 表未读）
3. 右侧 `Button variant='dots'` 三点菜单

**容器**：
- 整体外观：深色玻璃圆角胶囊（`surface-glass-dark` + `backdrop-filter: blur`）
- 圆角：`--radius-pill` 级（胶囊形），左右两端完全圆
- 轻发光边（1px 半透明描边 + 柔光 box-shadow），背景里隐隐透一点蓝紫
- 宽约 340px，高约 80px

**行为**：
- 整体可拖拽（`-webkit-app-region: drag`，交给 template 层而不是 Surface）
- 主体点击 → 展开成 ChatPanel
- 右侧菜单点 → 下拉菜单（设置 / 退出等）

---

## 2. 多窗口层叠（32 / 36 手绘草图）

**产品决策**：
- 单胶囊 → 未来会堆叠多个（多 agent / 多会话同时浮在桌面）
- 第二张图示意：3 个胶囊前后错位层叠，类似 macOS 窗口堆
- 实现上：每个窗口一个 Electron BrowserWindow，前端只管各自渲染；主 WS 连接由 Capsule 主窗口维持 + IPC 广播

**当前 P0 不需要**实现层叠动画，只需保证多窗口并存不冲突。

---

## 3. 完整聊天面板（40.png）⭐ 核心

**整体结构**（自上而下）：

```
┌─────────────────────────────────────────┐
│ 顶栏：Logo + M-TEAM + 在线点             ×│  ← ChatHeader
├─────────────────────────────────────────┤
│                                         │
│  [M] Claude                             │   ← 左气泡：agent
│       你好！我是 MTEAM...  😊           │     MessageBubble variant='agent'
│       20:48                             │     + Avatar + agentName + time
│                                         │
│                        帮我总结当前     │   ← 右气泡：user
│                        Agent 的状态     │     MessageBubble variant='user'
│                                 20:49   │
│                                         │
│  [M] Claude                             │
│       好的，当前 3 个 Agent 均在线：     │
│       · claude-code: 空闲               │
│       · codex-agent: 运行中（任务: 修   │
│         复 UI Bug）                     │
│       · qwen-dev: 空闲                  │
│       20:49                             │
│                                         │
│                        帮我优化 MTEAM   │
│                        的 UI 设计       │
│                                 20:50   │
│                                         │
│  [M] Claude                             │   ← thinking 态
│       · · ·                             │     ThinkingIndicator
│                                         │
├─────────────────────────────────────────┤
│  [Claude] [Codex] [Qwen] [+]            │   ← AgentTabBar / AgentSwitcher
│  ┌────────────────────────────┐ [➤]    │   ← ChatInput + 发送按钮
│  │ 给 MTEAM 发送消息...       │        │
│  └────────────────────────────┘        │
└─────────────────────────────────────────┘
```

**关键视觉点**：

| 位置 | 细节 |
|---|---|
| 左气泡（agent） | `surface-glass-dark` 深玻璃 + 圆角 ~20px + 轻发光边；气泡**上方**先显示 agent 名称（蓝色文字）再显示内容；内容下一行是时间戳（小字，白 45%） |
| 左气泡头像 | 小 M Logo（~32px）贴在气泡**左外侧下沿**，而非顶部 |
| 右气泡（user） | 蓝色半透明底（`--color-accent-primary` 低透明度），圆角同左，时间戳在气泡内部底部；设计稿里**没有明显的双勾已读**（`ReadReceipt` 可为 P1） |
| thinking 态 | 见 §4（独立节讲） |
| 混排内容 | 支持 bullet list（`· ` 开头），emoji 原生显示；**初期只处理 `\n` → `<br/>`，不上 react-markdown** |
| 宽度 | 气泡 max-width ~78%，左右成镜像 flex 布局 |

**Agent Tab（底栏左）**：
- 三个并列 chip：`Claude` / `Codex` / `Qwen` + `+` 按钮
- 当前激活者字色高亮、底色加深（`agent-chip--active`）
- `+` 按钮添加新 agent

**输入框**：
- 暗色玻璃底，圆角 ~12-16px
- 右侧圆形**蓝色**发送按钮（`--color-accent-primary` 实底，白色箭头）
- placeholder：`给 MTEAM 发送消息...`

---

## 4. Agent 思考态（39.png）⭐

**独立成章因为这张图容易漏掉**。

**视觉**：
- 小型浅玻璃胶囊（比主消息气泡更小、更浅）
- 左侧小 M Logo（~24px）+ 绿色在线点
- 气泡内：
  - 第一行 `Claude`（蓝色文字，12-13px）
  - 第二行：三点动画 `· · ·`（横向排列，带弹跳）
- 整体体积小（约 120×60px）

**与 CHAT-UI-RESEARCH §3 的关系**：
- 研究文档建议"`MessageBubble` 内部三态切换（thinking/streaming/done）不拆组件"
- 但设计稿 39 说明 thinking 态**视觉上是独立的一块小浮动组件**，不是普通消息气泡缩水
- **裁决建议**：P0 可以按研究文档路径（MessageBubble 内嵌 TypingDots 原子）做，但后续可能要拆 `ThinkingIndicator` 成独立 molecule，和主消息列分离渲染。现有代码 `MessageBubble.tsx` 已经支持 `variant='thinking'` 且内部渲染三点动画，满足 P0。

---

## 5. 颜色与字号（从设计稿反推）

> 无原始 Figma Token，以下为像素级观察估算，与 tokens.css 实际值对齐。

| 元素 | 估算值 | tokens.css 对齐 |
|---|---|---|
| 主标题（M-TEAM） | #EAEDF5 ~ #F0F2F7，15px，semibold | `--color-text-primary` + `--font-size-lg` + `--font-weight-semibold` |
| 副文 | 白 60%，12-13px | `--color-text-secondary` + `--font-size-sm` |
| 时间戳 | 白 40-45%，11px | `--color-text-tertiary` + `--font-size-xs` |
| Agent 名（蓝色） | `#6BA5FF` 左右 | 应走 `--color-accent-primary`（当前 #4aa3ff，接近） |
| 用户气泡底 | 蓝色 rgba(74,163,255,0.35) 左右 | **新 token** `--bubble-accent-fill` ✗ 未落 |
| Agent 气泡底 | 深玻璃 rgba(34,36,47,0.85) | `--surface-glass-dark` ✓ |
| 在线 dot | 亮绿 #23C55E | `--color-accent-success` ✓ |
| 未读 dot（蓝） | `--color-accent-primary` | ✓ |

**tokens.css 仍缺的**（CHAT-UI-RESEARCH §4.3 提出过）：
- `--glow-soft / --glow-medium / --glow-strong`（气泡发光三档）
- `--bubble-accent-fill`（用户气泡蓝底）
- `--stroke-hairline`（1px 半透明描边）

---

## 6. 交互动效

**胶囊 → 聊天展开**：
- 胶囊高度延展 → 内部淡入 ChatPanel（研究文档 §0 估 200ms）
- 建议用 `--duration-base: 200ms` + `--easing-standard`

**Agent 思考动画**：
- 三点跳动：纯 CSS keyframes，三个点用 `nth-child` 错开 160ms delay，周期 1.2s（见 CHAT-UI-RESEARCH §3.2）

**消息进入**：
- 从 max-height: 0 → auto + opacity 0→1 的 200-320ms 过渡
- 或直接出现（设计稿没明确动画要求，保守做法是无动画）

**滚动粘底**：
- `VirtualList` 已实现：距底 < 20px 自动跟新（CHAT-UI-RESEARCH §5.3 要求 120px，可调）

---

## 7. 与其他参考文档的对照

| 文档 | 该看什么 |
|---|---|
| **本文件** `DESIGN-REFERENCE.md` | 像素/布局/色值的视觉真相 |
| `CHAT-UI-RESEARCH.md` | 为什么这样做（Q1 异形气泡 / Q2 思考态 / Q3 发光边方案权衡） |
| `COMPONENT-ARCHITECTURE.md` | 哪一层放什么、props 约定 |
| `FRONTEND-INVENTORY.md` | 当前代码已做 / 没做 / 偏离 |
| `PRODUCT-REQUIREMENTS.md` | 功能清单 / 优先级 / 交互流程 |

---

## 8. P0 视觉待补项（执行时对照本文件）

| # | 项 | 对应设计稿 | 所在层 |
|---|---|---|---|
| 1 | `MessageBubble` 尾巴（BubbleTail SVG） | 40 | atom |
| 2 | 用户气泡的蓝色底色（需要 `--bubble-accent-fill` token） | 40 | tokens + MessageBubble |
| 3 | Agent 名蓝色字，固定走 `--color-accent-primary` | 40、39 | 文字样式 |
| 4 | 思考态小框的视觉匹配（目前 MessageBubble 内部实现够用） | 39 | molecule |
| 5 | Agent tab 激活态视觉（当前代码已实现，需与 40 比对字号边距） | 40 | molecule |
| 6 | 胶囊主态右侧三点菜单（当前 `Button variant='dots'` 已做） | 31 | organism |
| 7 | 聊天窗顶栏在线 dot（小型 StatusDot） | 40 | organism |

---

文档路径：`/Users/zhuqingyu/project/mcp-team-hub/packages/renderer/DESIGN-REFERENCE.md`
