# M-TEAM 前端产品需求文档（PRD）

> 读者：前端开发 agent
> 范围：`packages/renderer`（Electron 多窗口）
> 对齐对象：`packages/backend` 现有 HTTP + WS 能力
> 设计稿：`~/.claude/image-cache/fe74fff4-db0c-4f7f-8675-9cd440531a25/*.png`

---

## 0. 产品一句话

**一个常驻桌面的、可随时收起成胶囊的多 Agent 指挥中心**：
用户在一个胶囊 UI 里呼出聊天窗，与多位 Agent（Claude / Codex / Qwen / 自建模板）对话，实时看到它们思考、调工具、分任务；同时也是一个团队系统——Leader 可以拉起成员、下达任务、审批下线。

形态：
- **胶囊态**（默认）：只显示品牌 + agent 数 + 任务数 + 未读数。
- **展开态**：胶囊延展为聊天面板；支持多窗口层叠（设计稿 37 / 43）。
- **桌宠**：可选外挂形态（现有代码留位，非本期核心）。

---

## 0.1 服务端待补文档清单（前端阻塞依赖）

> team-lead 已确认服务端这 5 份文档正在补，本 PRD 遇到依赖这些文档的功能点**一律只写需求，不猜接口格式**，统一打 `[待服务端补充接口规范]` 标签。

| # | 缺失文档 | 影响的前端功能域 | 本 PRD 标签 |
|---|---|---|---|
| D1 | **消息三路分发设计**（comm-model-design 只有 Envelope，缺 `CommRouter.dispatch → agent/前端/DB` 架构图） | 聊天消息发送链路、用户 → Agent 的输入入口、前端如何从通讯路接消息 | `[待 D1]` |
| D2 | **Turn 聚合前端接口**（turn-aggregator-design 是后端视角，缺 WS JSON 形状 + HTTP 快照接口） | 聊天流式 / thinking / tool_call 渲染、Turn 历史回看、断线补齐 | `[待 D2]` |
| D3 | **通知系统前端接口**（notification-and-visibility.md 只有类型，缺三种代理模式的 HTTP 配置接口） | 通知中心、代理模式配置、静默/转发/提醒规则 | `[待 D3]` |
| D4 | **PROGRESS.md 过时** | 不影响功能，但前端排期不知道全局进度卡在哪 | `[待 D4]` |
| D5 | **整体架构总览**（comm / bus / ws / filter / notification / process-runtime / agent-driver 怎么拼） | 前端 WS 客户端拓扑（单例 vs 多窗口直连）、事件白名单边界、重连补偿策略 | `[待 D5]` |

**执行策略**：
- 所有 `[待 Dn]` 功能在实现前 block 到服务端文档落地；
- 前端可先做 UI 骨架 + 假数据演示，**禁止硬编码接口契约**；
- 每份文档到位后，PRD 对应条目需回填"已对齐"并引用文档 commit 号。

---

## 1. 功能清单（P0 / P1 / P2）

> P0 = 本期必做；P1 = 胶囊 MVP 之后第一阶段；P2 = 远期

### 1.1 胶囊 / 窗口层（P0）

| 功能 | 说明 | 对应 atom/molecule/organism |
|---|---|---|
| 胶囊收起态 | 显示 Logo + 团队名 + `N Agents · M Tasks` + `X New messages` + 菜单点 | `CapsuleCard`（已有） |
| 点击胶囊展开 | 胶囊滑动展开 → ChatPanel；支持窗口堆叠 | 新动画 + `ChatPanel` |
| 多窗口层叠 | 多个 agent / 会话窗口可同时浮在桌面 | Electron BrowserWindow 多开，前端只管自身渲染 |
| 拖拽 | Capsule / Panel 顶栏可拖 | `DragHandle`（已有） + template 层接管 `-webkit-app-region` |
| 关闭 | 面板右上 `×` 收回胶囊 | Button(icon=x) |

### 1.2 聊天（P0）

> 补充：再读一遍 `packages/backend/src/http/routes/` 后发现两个端点**已存在**，把相关项阻塞等级下调为"端点就绪、契约文档未齐"。完整端点清单见 `SERVER-API-INDEX.md`。

| 功能 | 服务端来源 | 前端需要 | 缺口 |
|---|---|---|---|
| 发送用户消息 | `POST /api/messages/send`（body: `to.address`/`content`/`kind='chat'`；服务端强注入 `from=user:local`） | `ChatInput`、`onSend`；成功返回 `{messageId, route}` | **`[待 D1 · 部分就绪]`** 端点在，但"发送成功→前端本地乐观渲染 id 如何对齐后端 messageId"、"三路分发到前端那一路的 WS 推送形状"仍依赖 D1 |
| 接收 Agent 回复（流式） | WS 推 turn.* | `MessageBubble.status='streaming'`，content 追加 | **`[待 D2]`** 前端订阅的 WS JSON 形状与后端 `turn-events.ts` 不必完全一致，须 D2 落契约 |
| 展示"正在思考" | WS turn.started → block thinking | `ThinkingIndicator`（`TypingDots`） | **`[待 D2]`** thinking block 字段与节奏待规范 |
| 展示工具调用 | WS block.type=tool_call | `ToolCallItem`（已有） + 折叠展开 | **`[待 D2]`** tool_call 中间态/终态 JSON 如何切换待规范 |
| 回合完成 | WS turn.completed | 气泡变 `done` 态 | **`[待 D2]`** |
| 切换当前 Agent | 底栏 Tab：`Claude / Codex / Qwen / +` | `AgentSwitcher`（已有，需扩多 tab） | — |
| 多 agent 消息流 | 每个 agent 一个 `driverId` | `chatStore` 按 `driverId` 分会话 | — |
| 历史回看 / 重连补齐 | `GET /api/panel/driver/:driverId/turns?limit=10` → `{active, recent}` | 面板打开 / 重连后先拉此接口填视图 | **`[待 D2 · 部分就绪]`** 端点在，但 WS 与 HTTP 的"去重 + 合并"策略需要 D2 给出权威指引（避免快照 + 实时 重复渲染） |
| 前端如何从"通讯路"接消息 | CommRouter → 前端路线 | 面板订阅、未读标记 | **`[待 D1]`** 三路分发里"到前端"那一路仍不清楚走 WS 推送还是拉 `GET /api/messages/:id`，还是订阅 `comm.message_received` 事件+本地查 envelope |

### 1.3 Agent / 实例管理（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 列出当前所有实例 | `GET /api/role-instances`（handleListInstances） | `AgentList`（organism，待建） |
| 创建实例（从模板） | `POST /api/role-instances`（handleCreateInstance） | `CreateInstanceDialog`（待建） |
| Leader 批准下线 | `POST /api/role-instances/:id/request-offline`（需 leader 权限） | `AgentStatusMenu` 的"请求下线"按钮 |
| 删除实例 | `DELETE /api/role-instances/:id?force=` | 确认弹窗 |
| 实时状态 | WS `instance.created / activated / offline_requested / deleted / session_registered` | `instanceStore` 监听事件更新 |

### 1.4 团队（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 列出 / 查看团队 | `GET /api/teams`、`GET /api/teams/:id` | `TeamList`、`TeamDetail` |
| 创建团队 | `POST /api/teams`（name + leaderInstanceId） | `CreateTeamDialog` |
| 解散团队 | `POST /api/teams/:id/disband` | 确认弹窗 |
| 添加成员 | `POST /api/teams/:id/members`（instanceId + roleInTeam） | 成员选择器 |
| 移除成员 | `DELETE /api/teams/:id/members/:instanceId` | 列表项右键 |
| 实时同步 | WS `team.created / disbanded / member_joined / member_left` | `teamStore` 订阅 |

### 1.5 角色模板（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 模板列表 | `GET /api/role-templates` | `TemplateList` |
| 新建 / 编辑 | `POST / PATCH /api/role-templates/:name` | `TemplateEditor`（name/role/persona/availableMcps） |
| 删除 | `DELETE /api/role-templates/:name` | 确认弹窗；被实例引用时服务端返 409 |
| 实时同步 | WS `template.created / updated / deleted` | `templateStore` 订阅 |

### 1.6 Primary Agent / 总控配置（P0）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 查看当前总控配置 | `GET /api/primary-agent` | 设置面板 |
| 配置总控（name / cliType / systemPrompt / mcpConfig） | `POST /api/primary-agent/config` | `PrimaryAgentSettings` |
| 启动 / 停止总控 | `POST /api/primary-agent/start` / `stop` | 主开关按钮；状态从 WS `primary_agent.started/stopped` 同步 |
| CLI 可用性 | `GET /api/cli`、`POST /api/cli/refresh`；WS `cli.available / unavailable` | 设置页里"检测到的 CLI"列表 |

### 1.7 MCP 工具（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| MCP Store 列表 | `GET /api/mcp-store` | `McpStorePanel`（P1） |
| 安装 MCP | `POST /api/mcp-store/install`（name/command/args/env/transport） | `InstallMcpDialog` |
| 卸载 MCP | `DELETE /api/mcp-store/:name` | builtin 不允许 |
| 实时同步 | WS `mcp.installed / uninstalled` | `mcpStore` 订阅 |
| 工具搜索（调用 agent 场景） | `GET /api/mcp-tools/search?instanceId&q` | 聊天内 `/tool` 搜索面板（P2） |

### 1.8 Roster / 通讯录（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 列出 roster | `GET /api/roster?scope=team\|local\|remote&callerInstanceId` | `RosterList` |
| 搜索 | `GET /api/roster/search?q&scope&callerInstanceId` | 搜索框 |
| 备注名 | `PATCH /api/roster/:instanceId/alias` | 名字就地编辑 |
| 通讯 | WS `comm.registered / disconnected / message_sent / message_received` | 通讯状态角标 |

### 1.9 通知（P0）

| 功能 | 服务端 | 前端需要 | 缺口 |
|---|---|---|---|
| 未读消息数 | WS `notification.delivered`（target=user） | 胶囊上 `X New messages` | — |
| 通知卡片展示 | 前端按 `sourceEventId` 在本地事件缓存找原事件 | `NotificationCard`（已有 atom）+ `NotificationStack`（已有 molecule） | — |
| 通知点开跳转 | 点通知 → 打开对应 agent 聊天窗 | 路由 / 窗口管理 | — |
| 标记已读 / 忽略 | 本地状态（当前无服务端已读持久化） | `notificationStore` | — |
| **三种代理模式配置**（静默/转发/提醒 —— 按设计文档暗示存在此概念） | HTTP 配置接口未定 | 设置面板里的"通知策略"开关、规则表 | **`[待 D3]`** notification-and-visibility.md 只有类型枚举，缺配置接口与字段定义 |
| 通知目标为 `agent` 时的语义 | WS `notification.delivered.target={kind:'agent'}` | 前端是否要渲染？渲染到哪个窗口？ | **`[待 D3]`** |

### 1.10 Session / 会话（P1）

| 功能 | 服务端 API | 前端需要 |
|---|---|---|
| 注册 session | `POST /api/sessions/register`（内部由成员 agent 调） | 前端通常不直接调；但需要展示 session 绑定状态 |

### 1.11 桌宠（P2）

已有 `JellyPet` 目录，本期不扩展需求。

---

## 2. 每个功能对应的前端组件需求

### 2.1 现有可用（盘点）

| 层 | 组件 | 状态 |
|---|---|---|
| atom | Button / Icon / Logo / MessageMeta / NotificationCard / StatusDot / Surface / Text / ToolCallItem / TypingDots | ✅ 已有 |
| molecule | AgentSwitcher / Avatar / ChatHeader / ChatInput / DragHandle / MenuDots / MessageBadge / MessageBubble / MessageRow / NotificationStack / TitleBlock / ToolCallList | ✅ 已有 |
| organism | CapsuleCard / ChatPanel | ✅ 已有（ChatPanel 待接真实数据） |

### 2.2 需要新建

| 层 | 组件 | 用途 | 优先级 |
|---|---|---|---|
| atom | `BubbleTail` | 气泡尖角 SVG | P0（CHAT-UI-RESEARCH §5.1 已定） |
| atom | `ReadReceipt` | 双勾已读 | P1 |
| atom | `Caret` | 流式输入光标 | P0 |
| molecule | `ThinkingIndicator` | "正在思考" + TypingDots | P0 |
| molecule | `MessageListItem` | Avatar + Bubble + Meta 的左右镜像行 | P0 |
| molecule | `AgentTabBar` | 底栏多 agent tab（Claude / Codex / Qwen / +） | P0 |
| organism | `AgentList` | 实例列表（状态、任务、操作菜单） | P1 |
| organism | `TeamPanel` | 团队详情（成员 + 角色） | P1 |
| organism | `TemplateEditor` | 模板 CRUD 面板 | P1 |
| organism | `McpStorePanel` | MCP 安装 / 卸载 | P1 |
| organism | `SettingsPanel` | 总控配置 + CLI 列表 | P0 |
| organism | `NotificationCenter` | 胶囊外挂的通知抽屉 | P0 |
| template | `CapsuleWindow` | 胶囊窗口骨架 | P0 |
| template | `PanelWindow` | 面板骨架（顶栏 + 内容 + 底栏） | P0 |
| page | `CapsulePage` / `ChatPage` / `SettingsPage` / `PetPage` | Electron 多窗口入口 | P0（Capsule + Chat），P1（其他） |

### 2.3 服务端缺口（前端阻塞点 —— 已对齐 team-lead，等 D1~D5 文档）

统一挂到 §0.1 的 5 份缺失文档。本表列出"具体接口级"的阻塞项，对应哪份文档。
**更新**：读 `http/routes/` 后，缺口 #1 和 #2 的端点实际已存在；降级为"部分就绪"。

| # | 缺口 | 依赖文档 | 状态 | 前端兜底策略 |
|---|---|---|---|---|
| 1 | 用户消息发送入口 | **D1** | ✅ 已有 `POST /api/messages/send`（强注入 `from=user`）；契约文档未齐 | 可开工；成功回执与本地乐观消息对齐规则等 D1 |
| 2 | Turn 历史快照 HTTP | **D2** | ✅ 已有 `GET /api/panel/driver/:id/turns`（`active + recent[]`） | 可开工；与 WS 实时事件的合并策略等 D2 |
| 3 | Turn WS 事件前端 JSON 形状 | **D2** | ⚠️ 只有后端 interface；前端契约未定 | 不硬编码解析；加适配层隔离 |
| 4 | `notification.delivered.target=agent` 语义 | **D3** | ⚠️ 未定义 | 暂忽略 agent 目标事件 |
| 5 | 三种通知代理模式的配置接口 | **D3** | ⚠️ 未定义 | 设置面板"通知策略"做禁用占位 |
| 6 | WS 连接拓扑（主进程中转 vs 每窗口直连） | **D5** | ⚠️ 未定义 | 先单例挂 Capsule 主窗口 + IPC 广播 |
| 7 | 断线重连后的补偿语义 | **D5** | ⚠️ 未定义 | 先做"重连 → 对所有 store 重跑 HTTP 冷启动"兜底 |
| 8 | 前端事件白名单边界 | **D5** | ⚠️ 未定义 | 不在前端复用后端 `WS_EVENT_TYPES` 常量 |

---

## 3. 交互流程

### 3.1 胶囊 → 聊天 → 切 Agent → 查看工具调用 → 收起

```
[胶囊态]
  显示: Logo | M-TEAM | 3 Agents · 2 Tasks | 5 New messages | ⋮
        ↓ 点击胶囊主体
[展开动画 ~200ms]
  胶囊高度延展 → 内部渲染 ChatPanel（glass 底继承）
        ↓
[聊天态]
  顶栏: Logo | M-TEAM | StatusDot(online) | ×
  消息区:
    [左] Claude   "你好！..."                [20:48]
    [右]                         "帮我总结..."  [20:49]
    [左] Claude   [ToolCallItem: mteam.list_members]
                  [ToolCallItem: mnemo.search]
                  "好的，当前..."
    [左] Claude   ThinkingIndicator("正在思考 ···")
  底栏:
    [ Claude ] [ Codex ] [ Qwen ] [ + ]    ← AgentTabBar
    [ 发送消息...                 ] [ ➤ ]  ← ChatInput
        ↓ 点击 [ Codex ] tab
  chatStore.currentDriverId = codexDriverId
  MessageList 切到 codex 的消息流（不清空 claude 状态）
        ↓ 点击 ToolCallItem
  展开/折叠工具入参 + 出参
        ↓ 点击顶栏 ×
[收起动画]
  ChatPanel → 胶囊态；未读消息计数刷新
```

### 3.2 Agent 思考 → 流式输出 → 完成

> 本流程大面积依赖 `[待 D1]` 和 `[待 D2]`，下面的接口名仅示意，不是契约。

```
用户按 Enter → onSend(text)
  POST <用户消息入口 —— 待 D1 定义>
  chatStore 本地立即追加一条 user message（乐观渲染）

WS: turn.started { driverId, turnId }
  末尾挂 ThinkingIndicator

WS: turn.block_updated { block: thinking }  (Claude 特有)
  thinking 气泡显示思考内容（可折叠）

WS: turn.block_updated { block: text, status: streaming }
  新气泡出现，content 原地增长，末尾 <Caret>

WS: turn.block_updated { block: tool_call, status: in_progress }
  气泡内嵌 ToolCallItem，loading 图标

WS: turn.block_updated { block: tool_call, status: completed }
  ToolCallItem 展示 output，可展开

WS: turn.block_updated { block: text, status: done }
  去掉 <Caret>

WS: turn.completed { turn: FullTurn }
  归档 chatStore.history；ThinkingIndicator 移除
```

### 3.3 通知弹出 → 处理

```
WS: notification.delivered { target: {kind:'user'}, sourceEventId: 'evt-xxx' }
  notificationStore.add(sourceEventId)
  本地 events 缓存查 sourceEventId → 取原事件（e.g. comm.message_received）
  胶囊右侧出现 NotificationStack；数字刷新

点击通知卡 → 打开对应 agent 聊天窗；标记本地已读
长按/右键 → 忽略
```

### 3.4 Agent 状态变化

```
WS: instance.created → AgentList 插入一行（status=PENDING）
WS: instance.activated → status=ACTIVE，头像 StatusDot 绿
WS: instance.offline_requested → status=PENDING_OFFLINE，橙
WS: instance.deleted → 从列表移除，若是当前 tab 自动切邻近
WS: container.crashed → 行尾出"异常退出"角标，支持一键 restart
```

### 3.5 多窗口层叠（设计稿 37 / 43）

```
主胶囊 + N 个聊天 / 设置窗口可同时浮在桌面：
- 每个 Electron BrowserWindow 对应一个 Page
- Capsule 和 ChatPanel 之间通过 Electron IPC（不是 fetch）同步 UI 态
- 全局 WS 连接只维持一个（建议挂在 Capsule 主窗口），通过 IPC 广播事件给子窗口
```

---

## 4. 数据流

### 4.1 数据来源分工

| 数据 | 来源 | 频率 | 落点 |
|---|---|---|---|
| 初始化静态数据（模板 / MCP / CLI / Primary Agent 配置） | HTTP GET | 启动一次 | `templateStore`, `mcpStore`, `cliStore`, `primaryAgentStore` |
| Turn / Chat 消息（运行时） | WS | 实时 | `chatStore` |
| Agent / Team / Roster 变化 | WS（实时） + HTTP（冷启动拉快照） | 混合 | `instanceStore`, `teamStore`, `rosterStore` |
| 通知 | WS `notification.delivered` + 本地事件缓存查 sourceEventId | 实时 | `notificationStore` |
| UI 本地态（窗口模式、sidebar 开合、当前 agent tab） | 无服务端 | — | `uiStore` |
| 总控启停 | HTTP POST 主动 + WS `primary_agent.*` 同步 | — | `primaryAgentStore` |

### 4.2 建议的 store 结构（现状 + 扩展）

现状 `src/store/` 过于粗略。建议按领域拆：

```
src/store/
├── index.ts                # 汇总导出
├── chatStore.ts            # { byDriverId: Map<id, {turns, activeTurn, streaming}> , currentDriverId }
├── instanceStore.ts        # 实例列表 Map<instanceId, RoleInstance>
├── teamStore.ts            # 团队 Map<teamId, Team>, members
├── templateStore.ts        # 模板 Map<name, Template>
├── mcpStore.ts             # MCP 列表 Map<name, McpConfig>
├── rosterStore.ts          # Roster Map<instanceId, RosterEntry>
├── cliStore.ts             # CLI 可用性 Map<cliName, CliInfo>
├── primaryAgentStore.ts    # { config, running }
├── notificationStore.ts    # 通知队列 + 事件缓存
├── eventCacheStore.ts      # 最近 N 条 WS 原事件（供 notification sourceEventId 反查）
└── uiStore.ts              # 窗口 / tab / sidebar 等纯 UI 状态
```

### 4.3 WS 连接管理 `[待 D5]`

- 单例连接：建议 `src/api/ws.ts` 起一个 `WsClient`，`Capsule` 页面首次挂载时 connect。
- 断线重连：指数退避；重连后对每个"实时 + 冷快照"域，跑一遍 HTTP 冷启动拉取（见 §4.1）。
- 事件分发：`bus.emit` 形式（RxJS / mitt 都行）把 WS 事件广播到各 store；event type 白名单**暂时**参考 backend `WS_EVENT_TYPES`（见 `bus/subscribers/ws.subscriber.ts`），待 **D5** 明确"前端订阅契约"后回填。
- 多窗口共享：**待 D5** 给出拓扑裁决；本期先落"主进程中转 + IPC 广播"草案，文档到位再确认。

### 4.4 事件 → store 映射（P0 核心）

| WS 事件 | 触达 store | 具体动作 |
|---|---|---|
| `turn.started` | chatStore | 新建 activeTurn；UI 显示 thinking |
| `turn.block_updated` | chatStore | 按 blockId upsert；seq 递增追加 |
| `turn.completed` | chatStore | 归档 turn；清 activeTurn |
| `turn.error` | chatStore | 当前 turn 标 error |
| `instance.*` | instanceStore | CRUD |
| `team.*` | teamStore | CRUD |
| `template.*` | templateStore | CRUD |
| `mcp.*` | mcpStore | CRUD |
| `cli.*` | cliStore | 更新可用性 |
| `primary_agent.*` | primaryAgentStore | 状态同步 |
| `container.*` | instanceStore（或独立 containerStore） | 生命周期 |
| `comm.*` | rosterStore / chatStore | 状态/消息 |
| `notification.delivered` | notificationStore | 入队 |

---

## 5. 非功能需求

- **性能**：单次 WS `turn.block_updated` 到 UI 渲染 < 50ms；1000 条消息滚动不卡。
- **IME**：中文输入合成期不触发发送（`compositionstart/end`）。
- **重连**：网络闪断 5s 内自动重连并补快照，用户不感知。
- **离线**：断线期间只允许浏览本地已缓存的 turn；发送按钮禁用 + tooltip 提示。
- **多窗口一致性**：胶囊的未读数和聊天窗的已读状态必须一致（依赖 IPC 或共享 store）。

---

## 6. 优先级总结

### P0（胶囊 MVP）
- CapsulePage + ChatPage 两个窗口
- ChatPanel 全链路（发送、流式、工具调用、思考）
- Primary Agent 启停 + 简单设置
- 通知中心
- WS 连接 + 冷启动 HTTP
- `chatStore` / `uiStore` / `primaryAgentStore` / `notificationStore`

### P1（团队管理完整化）
- AgentList / TeamPanel / TemplateEditor / McpStorePanel / RosterList
- 多 agent tab 真正切换
- 历史快照拉取

### P2（远期）
- 桌宠融合
- MCP 工具搜索面板
- 虚拟滚动
- Markdown 渲染

---

## 7. 对齐后的动作清单（给 team-lead）

1. 确认服务端 §2.3 四个缺口的答复（尤其缺口 #1，是聊天能否跑通的关键）。
2. 对齐 WS 连接模型：主进程中转 vs 每窗口直连。
3. 确认 P0 范围是否等同于「胶囊 + 一个 Claude 聊天窗 + 总控启停」。
4. 确认后续 P1 功能（模板 / MCP / 团队管理）是否单独开窗口，还是 ChatPanel 侧栏。

---

文档路径：`/Users/zhuqingyu/project/mcp-team-hub/packages/renderer/PRODUCT-REQUIREMENTS.md`
