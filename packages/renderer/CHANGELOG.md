# MTEAM Renderer 迭代日志

> 范围：`packages/renderer`（Electron 多窗口前端 + 组件库 + Playground）
> 起点：2026-04-25
> 记录方式：按日期分节，每日内按 Round 顺序推进，Round 内列产出与决策。

---

## 2026-04-25

### Round 1 — 胶囊浮窗 Demo

产出：

- CapsuleCard 胶囊组件（暗色毛玻璃主题）落地
- M Logo（3D 冰晶效果，PIL 自动裁切居中）
- Electron 透明无边框窗口搭建
- 展开/收起动画：CSS transition（内容层）+ `BrowserWindow.setBounds(animate)`（窗口层）联动

基线：无 Token 体系，样式集中在 `src/styles/capsule.css`；`Surface` 与窗口 drag 耦合；`store/` 为 jotai 空壳。

### Round 2 — 原子设计组件体系

产出：

- 架构设计文档：`COMPONENT-ARCHITECTURE.md`
  - 分层：`design-tokens → atoms → molecules → organisms → templates → pages`
  - 一条铁律：禁止反向依赖；抽象跟随场景，第一次出现不抽
- Tailwind CSS 接入：`tailwind.config.ts` 的 `theme.extend` 直接消费 `tokens.css` 的 CSS 变量
- Zustand 引入（替换 jotai）：按领域拆 store（`chat / instance / team / template / mcp / roster / cli / primaryAgent / notification / eventCache / ui`）
- 目录骨架：`atoms/ molecules/ organisms/ templates/ pages/ design-tokens/`

Atoms（11 个）：`Button / Icon / Logo / MessageMeta / NotificationCard / StatusDot / Surface / Text / ToolCallItem / TypingDots / VirtualList`

Molecules（12 个）：`AgentSwitcher / Avatar / ChatHeader / ChatInput / DragHandle / MenuDots / MessageBadge / MessageBubble / MessageRow / NotificationStack / TitleBlock / ToolCallList`

Organisms（2 个）：`CapsuleCard / ChatPanel`

### Round 3 — Playground 展示站

产出：

- 独立 Vite 服务：`playground/`（`main.tsx / App.tsx / registry.ts / playground.css`）
- `ComponentCard` 通用展示卡片：demo + props 控制面板（`PropsPanel`）+ API 描述
- 所有组件注册到 `registry.ts`，统一入口
- 交互验证：props 控制实时生效；Events 日志窗面板

背景：不选 Storybook 是为了零额外依赖，直接 Vite 起静态站，最小摩擦。

### Round 4 — 复合组件 + 调研

产出：

- 复合组件：
  - `MessageRow` = Avatar + Bubble + Meta 组合消息行，左右镜像
  - `ChatHeader` 展开态顶栏（Logo + Title + StatusDot + Close）
  - `ToolCallItem` + `ToolCallList`：工具调用展示（折叠/展开入参出参）
  - `NotificationCard` + `NotificationStack`：通知堆叠
  - `VirtualList`：虚拟滚动（先落原子，消息量级到 500 条再启用）
- 调研文档：`CHAT-UI-RESEARCH.md`
  - 异形气泡方案对比（A 伪元素 / B SVG / C clip-path / D 本体圆角+外挂 SVG 尾巴）→ 选 D
  - 思考态：`MessageBubble` 内部三态切换（`thinking / streaming / done`），不拆组件
  - 发光边框：不新建 `GlowBorder`，扩展 `Surface.variant` 并拆 drag 耦合
- 产品需求：`PRODUCT-REQUIREMENTS.md`
  - 胶囊态 / 展开态 / 桌宠三形态
  - P0 / P1 / P2 功能清单与组件映射
  - 服务端缺口 D1–D6（消息三路分发 / Turn 前端契约 / 通知代理模式 / PROGRESS / 整体架构 / `/api/panel/` facade）
  - 前端硬门禁：只走 `/api/panel/`，不调底层接口

### Round 5 — API 合规重构 + 滚动条

产出：

- API 层合规重构：所有 HTTP 调用迁至 `/api/panel/*` facade（遵循 D-6 硬门禁）
  - 按域拆分：`driver-turns / instances / mcp / primaryAgent / roster / sessions / teams / templates / cli`
  - 统一 `ApiResult { ok, status, data, error }` 返回契约
  - 旧 `client.ts` 里违反门禁的 Team API 封装全量下线
- 滚动条系统：`tokens.css` 增补 `--scrollbar-*` 变体；`ChatPanel / AgentList / NotificationCenter` 统一接入
- IME 合成期保护：`ChatInput` 加 `compositionstart/end` 守卫，中文输入法 Enter 不误发

### Round 6 — 真实交互（store actions + 发消息流程）

产出：

- Store actions 补齐：`messageStore.send / agentStore.switch / taskStore.create` 等动作层
- `ExpandedView` 串联：消息面板 → store → API → WS 回写闭环
- 发消息流程：`ChatInput` → `messageStore.send` → `POST /api/panel/comm/send` → WS `turn.*` 事件回流 → block upsert
- 虚拟滚动按 D-12 退回普通滚动（P0 范围消息 <500 条）

### Round 7 — WS 事件接线

产出：

- `src/api/ws.ts` WS 客户端单例：带自动重连 + 指数退避 + 冷启动 HTTP 兜底
- `hooks/useWsEvents.ts`：订阅服务端 WS 事件并分发到对应 store
- 事件白名单：`turn.* / notification.* / instance.* / team.*`
- Store 订阅链路全通：WS → store → UI 自动刷新

### Round 8 — P1 UI 组件补全

产出：

- `organisms/NotificationCenter`：通知中心面板，按 agent 分组，支持签收/批量清理
- `organisms/AgentList`：Agent 列表，在线/离线分段显示
- `organisms/TemplateEditor`：模板编辑器（基于模板 API）
- `organisms/PrimaryAgentSettings`：主 Agent 设置面板
- `molecules/RosterList`：花名册列表
- `molecules/CliList`：CLI 会话列表
- 设置窗口 / CLI 窗口入口接入

### Round 9 — Templates + Pages 架构层

产出：

- `templates/CapsuleWindow.tsx`：胶囊窗口骨架（含透明窗口 + drag 区）
- `templates/PanelWindow.tsx`：面板窗口骨架（设置/聊天/CLI 复用）
- `pages/CapsulePage.tsx`：胶囊主页面（集成 `CapsuleCard`）
- `pages/TeamPage.tsx`：团队聊天主页面（集成 `ExpandedView / TeamCanvas`）
- `pages/SettingsPage.tsx`：设置主页面（集成 `PrimaryAgentSettings / TemplateEditor`）
- 每个 templates / pages 目录下配 `README.md`（给下一个 agent 看）
- `App.tsx` 路由分发改为 `CapsulePage / TeamPage / SettingsPage` 分派
- 设置窗口独立 BrowserWindow 落地

### Round 10 — 全面体验打磨

产出：

- 视觉精修：发光层级、气泡尖角对齐、动画时序（展开/收起 `setBounds` 与 CSS transition 同步）
- 交互精修：快捷键、焦点管理、错误态/空态、loading 骨架屏
- 性能：`messageStore` 按 `driverId` 分段；大列表 memo；避免重复订阅
- Playground 深度交互测试 + 逐像素检查胶囊 / 展开态
- 组件体系终局统计：**atoms 12 / molecules 16 / organisms 9 / templates 2 / pages 3 / hooks 2 / api 12 / store 7**
- TS `--noEmit` 零错 + `vite build` 成功（124 modules，gzip 68KB）

---

## 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 不用 Storybook，自建 Playground | Vite 已在，Storybook 带配置 + 体积 + 额外学习成本；自建够用且可嵌 props 面板 |
| D-2 | 不用 CSS Modules，纯 CSS + BEM → 迁移到 Tailwind | 原子化 CSS 天然匹配原子设计分层；Token 映射到 `theme.extend` 更直接 |
| D-3 | 不用 jotai，改 zustand | jotai 原子粒度过细，跨窗口共享与 IPC 协作复杂；zustand 更贴近 store-per-domain 的规划 |
| D-4 | Logo 在线=彩色，离线=灰度，不用绿点 | 胶囊尺寸小，角标绿点视觉负担重；灰度反差同时承载状态与品牌 |
| D-5 | 通知由 agent 签收，不是用户 dismiss | 通知模型面向 agent 调度，不是传统"用户已读"语义；UI 不提供忽略按钮 |
| D-6 | 前端只走 `/api/panel/`，不调底层接口 | 面板 API 作 facade 层隔离底层重构；每轮迭代专岗 grep 验收 |
| D-7 | 窗口 resize 用 `setBounds(animate)`，CSS 不做 width/height 动画 | 透明窗口下 CSS 动画与原生窗口尺寸脱节会抖；`setBounds` 原生平滑 |
| D-8 | 异形气泡选 "本体圆角 + 外挂 SVG 尾巴"（方案 D） | 保留 `box-shadow` 发光边；尾巴小哑一点肉眼可接受 |
| D-9 | 思考态不拆组件，`MessageBubble` 内部三态 | 拆组件会换整块 DOM，流式切换时抖动 |
| D-10 | 不新建 `GlowBorder`，扩 `Surface.variant` | 多套一层 DOM 会导致圆角/padding 传递困难；原子抽象收益低 |
| D-11 | 不引入 react-markdown（初期） | 包体 + 性能成本高；先正则处理 `\n` + bullet，真实 markdown 再迭代 |
| D-12 | 不引入虚拟滚动（P0 范围） | 单窗口消息 < 500 条时手写滚动足够；`VirtualList` 原子先备着 |
| D-13 | WS 单例连接挂 Capsule 主窗口，IPC 广播 | 多窗口直连会重复订阅与重复补偿；等 D5 文档确认后再回填 |

---

## 服务端阻塞清单（前端视角）

> 详见 `PRODUCT-REQUIREMENTS.md §0.1 / §0.2 / §2.3`

| # | 缺口 | 状态 | 前端兜底 |
|---|---|---|---|
| D1 | 消息三路分发设计（CommRouter → agent/前端/DB） | 端点在，契约未齐 | UI 骨架 + 假数据 |
| D2 | Turn 聚合前端接口（WS JSON + HTTP 快照） | HTTP 已就绪，WS 契约未齐 | 加适配层隔离 |
| D3 | 通知系统前端接口（三种代理模式） | 未定义 | 设置面板做禁用占位 |
| D4 | PROGRESS.md 过时 | 待补 | 不影响前端功能 |
| D5 | 整体架构总览（WS 拓扑 / 事件白名单 / 重连补偿） | 未定义 | 单例 WS + HTTP 冷启动兜底 |
| D6 | `/api/panel/*` facade 层 | 仅 1 个端点，P0 所需全缺 | P0 HTTP 交互全部阻塞，UI 骨架先行 |

---

## 文件索引

| 文件 | 用途 |
|---|---|
| `COMPONENT-ARCHITECTURE.md` | 分层、Token、CSS 策略、Props 约定、迁移计划 |
| `CHAT-UI-RESEARCH.md` | 聊天 UI 方案调研（异形气泡 / 思考态 / 发光边框） |
| `PRODUCT-REQUIREMENTS.md` | 产品需求（功能清单 / 交互流程 / 数据流 / 服务端缺口） |
| `FRONTEND-INVENTORY.md` | 前端组件盘点 |
| `SERVER-API-INDEX.md` | 服务端 HTTP 端点索引 |
| `SERVER-EVENTS-INDEX.md` | 服务端 WS 事件索引 |
| `CHANGELOG.md` | 本文档，迭代日志 |
