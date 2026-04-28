# 前端接口总入口 INDEX

> **面向**：前端开发者。这里列出所有前端可以调的接口（WebSocket + HTTP），每行一个。看这一份就知道全部能力；某个接口要看完整契约再点链接进对应子文档。
>
> **黑白分明**：
> - 第 1–4 节 = **白名单**（前端能调的就这些）
> - 第 5 节 = **黑名单**（前端禁调；包含 agent bootstrap / 后端 subscriber / MCP HTTP / Unix Socket / 未挂路由的建议端点 / 非白名单 bus 事件）
> - **在第 1–4 节里找不到的接口默认都是禁调的**，不要凭猜测调底层路径。

---

## 1. WebSocket `/ws/events`

连接 URL：`ws://<host>:<port>/ws/events?userId=<userId>`（单机默认 `userId=local`）。
消息契约详见 [ws-protocol.md](./ws-protocol.md)。

### 1.1 上行 op（前端 → 后端）

| op | 关键字段 | 一句话 | 详细 |
|---|---|---|---|
| `subscribe`   | `scope`（global/team/instance/user）, `id?`, `lastMsgId?` | 订阅事件流；断线重连带 `lastMsgId` 触发 gap-replay | [ws-protocol.md §subscribe](./ws-protocol.md) |
| `unsubscribe` | `scope`, `id?`                                          | 退订                                              | [ws-protocol.md §unsubscribe](./ws-protocol.md) |
| `prompt`      | `instanceId`, `text`, `requestId?`                      | 向 instance（成员或 primary agent）投递一条用户消息，fire-and-forget | [ws-protocol.md §prompt](./ws-protocol.md) · [message-flow §场景1](./message-flow.md) |
| `ping`        | —                                                       | 心跳；建议 30s 一次                                | [ws-protocol.md §ping](./ws-protocol.md) |
| `configure_primary_agent` | `cliType`, `name?`, `systemPrompt?`, `requestId?` | 配置主 Agent（切 cliType 触发 stop→start，全走事件流） | [ws-protocol.md §configure_primary_agent](./ws-protocol.md) · [primary-agent-api §迁移对照](./primary-agent-api.md) |
| `get_turns`   | `driverId`, `limit?`, `requestId?`                                  | 拉 turn 内存快照（`{ active, recent }`，断线重连先拉这条）                           | [ws-protocol.md §get_turns](./ws-protocol.md) · [turn-events §4 快照查询](./turn-events.md) |
| `get_turn_history` | `driverId`, `limit?`, `beforeEndTs?`, `beforeTurnId?`, `requestId?` | 拉 turn 持久化冷历史（keyset 翻页，上滑加载）                                       | [ws-protocol.md §get_turn_history](./ws-protocol.md) · [turn-events §8 冷历史接口](./turn-events.md) |
| `get_workers` | `requestId?` | 拉数字员工列表 + 在线/空闲/离线统计（= 角色模板的视图聚合） | [workers-api §get_workers](./workers-api.md) |
| `get_worker_activity` | `range`, `workerName?`, `requestId?` | 拉员工活跃度（`range` = minute/hour/day/month/year；不传 `workerName` = 全员聚合） | [workers-api §get_worker_activity](./workers-api.md) |

### 1.2 下行消息（后端 → 前端）

| type           | 一句话 | 详细 |
|----------------|------|------|
| `event`        | 单条 bus 事件；`event.type` 按领域再分发 | [ws-protocol.md §event](./ws-protocol.md) · [bus-events.md](./bus-events.md) |
| `gap-replay`   | 断线重连补发批次；`upTo=null` 表示无 gap   | [ws-protocol.md §gap-replay](./ws-protocol.md) |
| `ack`          | `prompt` 的收件确认（非执行完成）          | [ws-protocol.md §ack](./ws-protocol.md) |
| `pong`         | `ping` 回复                                | [ws-protocol.md §pong](./ws-protocol.md) |
| `error`        | 连接级错误；`code` ∈ bad_request/not_found/forbidden/not_ready/internal_error | [ws-protocol.md §error](./ws-protocol.md) |
| `snapshot`     | 每次 WS 建连推一次，载荷 = 主 Agent 当前 Row（`primaryAgent:null` 表示未配置）；等价 `GET /api/primary-agent` | [ws-protocol.md §snapshot](./ws-protocol.md) · [primary-agent-api.md](./primary-agent-api.md) |
| `get_turns_response` | `requestId`, `active`, `recent` —— `get_turns` 的应答（内存 turn 快照） | [ws-protocol.md §get_turns_response](./ws-protocol.md) · [turn-events §4 快照查询](./turn-events.md) |
| `get_turn_history_response` | `requestId`, `items`, `hasMore`, `nextCursor` —— `get_turn_history` 的应答（冷历史翻页） | [ws-protocol.md §get_turn_history_response](./ws-protocol.md) · [turn-events §8 冷历史接口](./turn-events.md) |
| `get_workers_response` | `requestId`, `workers`, `stats` —— `get_workers` 的应答（员工列表聚合） | [workers-api §get_workers](./workers-api.md) |
| `get_worker_activity_response` | `requestId`, `range`, `workerName`, `dataPoints`, `total` —— `get_worker_activity` 的应答（分桶时间序列） | [workers-api §get_worker_activity](./workers-api.md) |

### 1.3 下行 bus 事件（`event.event.type`）

前端按 `event.type` 分发渲染。完整字段见 [bus-events.md](./bus-events.md)。

| 领域 | 事件 type | 一句话 | 详细 |
|---|---|---|---|
| instance     | `instance.created` / `activated` / `offline_requested` / `deleted` / `session_registered` | 角色实例生命周期 | [bus-events §instance](./bus-events.md) · [instances-api.md](./instances-api.md) |
| comm         | `comm.registered` / `disconnected` / `message_sent` / `message_received` | 消息分发事件（外层 `id`==messageId） | [bus-events §comm](./bus-events.md) · [message-flow.md](./message-flow.md) |
| template     | `template.created` / `updated` / `deleted`        | 模板变更                        | [bus-events §template](./bus-events.md) · [templates-and-mcp.md](./templates-and-mcp.md) |
| mcp          | `mcp.installed` / `uninstalled`                   | MCP 商店变更                    | [bus-events §mcp](./bus-events.md) · [templates-and-mcp.md](./templates-and-mcp.md) |
| team         | `team.created` / `disbanded` / `member_joined` / `member_left` | 团队生命周期 | [bus-events §team](./bus-events.md) · [teams-api.md](./teams-api.md) |
| cli          | `cli.available` / `unavailable`                   | CLI 扫描结果翻转                | [bus-events §cli](./bus-events.md) · [templates-and-mcp.md](./templates-and-mcp.md) |
| primary_agent| `primary_agent.started` / `stopped` / `configured` / `state_changed` | 总控 agent 生命周期 + 工作状态（idle/thinking/responding） | [bus-events §primary_agent](./bus-events.md) · [primary-agent-api.md](./primary-agent-api.md) |
| driver (部分)| `driver.started` / `stopped` / `error`            | Agent 在线/离线；**其余 `driver.*` 前端改用 `turn.*`** | [bus-events §driver](./bus-events.md) · [turn-events.md](./turn-events.md) |
| container    | `container.started` / `exited` / `crashed`       | 容器生命周期                    | [bus-events §container](./bus-events.md) |
| turn         | `turn.started` / `block_updated` / `completed` / `error` | Agent 工作流聚合块（思考/文本/工具/计划/用量） | [turn-events.md](./turn-events.md) |
| notification | `notification.delivered`                          | 通知指针（含 `sourceEventId` 指向原事件） | [bus-events §notification.delivered](./bus-events.md) · [notification-and-visibility.md](./notification-and-visibility.md) |
| action_item  | `action_item.created` / `updated` / `reminder` / `resolved` / `timeout` | 待办（task/approval/decision/authorization）生命周期；reminder 仅投 assignee | [bus-events §action_item](./bus-events.md) · [action-items-api.md](./action-items-api.md) |
| worker       | `worker.status_changed` | 数字员工在线/空闲/离线 / instanceCount / teams 增量推送；首屏发 `get_workers` 拉全量，之后靠推送，不轮询 | [bus-events §worker](./bus-events.md) · [workers-api §实时推送](./workers-api.md) |

> `driver.thinking` / `driver.text` / `driver.tool_call` / `driver.tool_result` / `driver.turn_done` 已从 WS 白名单移除，前端不要订阅，统一看 `turn.*`。

---

## 2. HTTP REST

Base URL = backend HTTP host（如 `http://localhost:58590`）。全部返回 JSON，错误 4xx/5xx + `{ error: string }`。

> **重要 · 前端调用总规则**：前端 **只走 §2.9 的 `/api/panel/*` 门面层**。§2.1-2.8 列出的底层路径（`/api/teams` / `/api/role-instances` / `/api/messages` / `/api/roster` / `/api/role-templates` / `/api/mcp-store` / `/api/mcp-tools` / `/api/cli` / `/api/primary-agent`）属于后端/agent 的内部契约，**前端禁调**（见第 5.1 节）。§2.1-2.8 保留下来是为了让前端知道门面层背后挂的是哪个 handler 以及对应的完整契约（点进子文档看），但**实际 fetch 的 URL 前缀必须是 `/api/panel/`**。

### 2.1 消息 messages ⚠️ 前端走 `/api/panel/messages`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| POST   | `/api/messages/send`                   | 前端发消息给 agent（`from` 强制 user） | [messages-api §send](./messages-api.md) · [message-flow §场景2](./message-flow.md) |
| GET    | `/api/messages/:id`                    | 按 envelope id 查单条；`?markRead=true` 同步标已读 | [messages-api §get](./messages-api.md) |
| GET    | `/api/role-instances/:id/inbox`        | 取某实例未读收件箱（`peek`/`limit`） | [messages-api §inbox](./messages-api.md) |
| GET    | `/api/teams/:teamId/messages`          | 按 team 维度拉历史（游标 `before`）   | [messages-api §team-history](./messages-api.md) |

### 2.2 角色实例 role-instances ⚠️ 前端走 `/api/panel/instances/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/role-instances`                               | 所有实例                                    | [instances-api §GET](./instances-api.md) |
| POST   | `/api/role-instances`                               | 创建实例（PENDING）                          | [instances-api §POST](./instances-api.md) |
| DELETE | `/api/role-instances/:id`                           | 删除（可 `?force=1`）                        | [instances-api §DELETE](./instances-api.md) |
| POST   | `/api/role-instances/:id/activate`                  | PENDING → ACTIVE（面板/测试走这条）         | [instances-api §activate](./instances-api.md) |
| POST   | `/api/role-instances/:id/request-offline`           | Leader 批准成员下线（header `X-Role-Instance-Id`） | [instances-api §request-offline](./instances-api.md) |

### 2.3 花名册 roster ⚠️ 前端走 `/api/panel/roster/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/roster`                     | 列 roster（支持 `scope=team/local/remote`） | [roster-api §GET](./roster-api.md) |
| GET    | `/api/roster/search`              | 按 alias/memberName 模糊搜索 | [roster-api §search](./roster-api.md) |
| GET    | `/api/roster/:instanceId`         | 查单个实例                   | [roster-api §GET-by-id](./roster-api.md) |
| PUT    | `/api/roster/:instanceId`         | 更新可变字段（status/address/teamId/task） | [roster-api §PUT](./roster-api.md) |
| PUT    | `/api/roster/:instanceId/alias`   | **设备注名（前端最常用）**   | [roster-api §alias](./roster-api.md) |
| DELETE | `/api/roster/:instanceId`         | 删除条目                     | [roster-api §DELETE](./roster-api.md) |

### 2.4 团队 teams ⚠️ 前端走 `/api/panel/teams/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/teams`                                     | 所有 team                    | [teams-api §GET](./teams-api.md) |
| POST   | `/api/teams`                                     | 创建 team                    | [teams-api §POST](./teams-api.md) |
| GET    | `/api/teams/:id`                                 | team 详情（含成员）           | [teams-api §detail](./teams-api.md) |
| POST   | `/api/teams/:id/disband`                         | 解散 team                    | [teams-api §disband](./teams-api.md) |
| GET    | `/api/teams/:id/members`                         | 成员列表                     | [teams-api §members-GET](./teams-api.md) |
| POST   | `/api/teams/:id/members`                         | 添加成员                     | [teams-api §members-POST](./teams-api.md) |
| DELETE | `/api/teams/:id/members/:instanceId`             | 移除成员                     | [teams-api §members-DELETE](./teams-api.md) |
| GET    | `/api/teams/by-instance/:instanceId`             | 按实例反查 ACTIVE team（members 已 enrich） | [teams-api §by-instance](./teams-api.md) |

### 2.5 模板与 MCP 商店 ⚠️ 前端走 `/api/panel/templates/*` 与 `/api/panel/mcp-tools` / `/api/panel/mcp/store`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/role-templates`            | 列模板                        | [templates-and-mcp §templates-GET](./templates-and-mcp.md) |
| POST   | `/api/role-templates`            | 创建模板                      | [templates-and-mcp §templates-POST](./templates-and-mcp.md) |
| GET    | `/api/role-templates/:name`      | 查单个模板                    | [templates-and-mcp §templates-get-one](./templates-and-mcp.md) |
| PUT    | `/api/role-templates/:name`      | 增量更新模板                  | [templates-and-mcp §templates-PUT](./templates-and-mcp.md) |
| DELETE | `/api/role-templates/:name`      | 删模板（有活跃实例会 409）    | [templates-and-mcp §templates-DELETE](./templates-and-mcp.md) |
| GET    | `/api/mcp-store`                 | 列 MCP（含内置 mteam）        | [templates-and-mcp §mcp-store-GET](./templates-and-mcp.md) |
| POST   | `/api/mcp-store/install`         | 安装用户 MCP                  | [templates-and-mcp §mcp-store-install](./templates-and-mcp.md) |
| DELETE | `/api/mcp-store/:name`           | 卸载 MCP（内置会 403）        | [templates-and-mcp §mcp-store-DELETE](./templates-and-mcp.md) |

### 2.6 CLI 扫描 ⚠️ 前端走 `/api/panel/cli/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/cli`                       | 读当前 CLI 快照（不触发扫描） | [templates-and-mcp §cli-GET](./templates-and-mcp.md) |
| POST   | `/api/cli/refresh`               | 立即重新扫描并返回最新快照    | [templates-and-mcp §cli-refresh](./templates-and-mcp.md) |

### 2.7a 头像库 ⚠️ 前端走 `/api/panel/avatars/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/panel/avatars`         | 列所有可见头像 | [avatars-api §GET](./avatars-api.md) |
| POST   | `/api/panel/avatars`         | 添加自定义头像 | [avatars-api §POST](./avatars-api.md) |
| DELETE | `/api/panel/avatars/:id`     | 删除/隐藏头像 | [avatars-api §DELETE](./avatars-api.md) |
| POST   | `/api/panel/avatars/restore` | 还原内置头像 | [avatars-api §restore](./avatars-api.md) |
| GET    | `/api/panel/avatars/random`  | 随机一个头像 | [avatars-api §random](./avatars-api.md) |

### 2.7b ActionItem（待办）⚠️ 前端走 `/api/panel/action-items/*`

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| POST   | `/api/panel/action-items`             | 创建待办（kind=task/approval/decision/authorization，deadline 必须 > now+1s） | [action-items-api §POST](./action-items-api.md) |
| GET    | `/api/panel/action-items`             | 列表（`assigneeId` / `creatorId` / `status` 过滤）                            | [action-items-api §GET-list](./action-items-api.md) |
| GET    | `/api/panel/action-items/:id`         | 查单个                                                                        | [action-items-api §GET-one](./action-items-api.md) |
| PUT    | `/api/panel/action-items/:id/resolve` | 解决（body `{status: done\|rejected}`）                                        | [action-items-api §resolve](./action-items-api.md) |
| PUT    | `/api/panel/action-items/:id/cancel`  | 取消（创建方主动放弃）                                                         | [action-items-api §cancel](./action-items-api.md) |

对应 WS 事件：`action_item.created / updated / reminder / resolved / timeout`，详见 [action-items-api §WS 事件](./action-items-api.md)。

> **数字员工（workers）前端只走 WS**：`get_workers` / `get_worker_activity`（见 §1.1 / §1.2），**不提供 HTTP 端点**。详见 [workers-api.md](./workers-api.md)。

### 2.7 Primary Agent（总控）⚠️ 前端已改走 WS（下列 HTTP 仅内部/调试）

> ## 🟢 设计原则（硬性约束）
>
> **主 Agent 对前端只暴露 WS 接口：实时推送（`turn.*` / `primary_agent.*`）+ 主动请求（`get_turns` / `get_turn_history`）。不新增任何 HTTP 端点。**
>
> 任何新增的主 Agent 相关能力一律走 WS（上行 op + 下行响应 / 事件）；下方 HTTP 端点仅保留给后端自身和调试脚本，前端禁调，且不再扩容。

> **前端迁移**：查状态走 WS `snapshot`、切 CLI 走 WS `configure_primary_agent`、启停靠应用生命周期、查 turn 快照走 WS `get_turns`、翻冷历史走 WS `get_turn_history`。详见 [primary-agent-api §迁移对照](./primary-agent-api.md) 与 [ws-protocol §configure_primary_agent](./ws-protocol.md) / [§snapshot](./ws-protocol.md) / [turn-events §4](./turn-events.md) / [turn-events §8](./turn-events.md)。

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/primary-agent`                   | 读当前配置（内部/调试，前端改走 WS snapshot）           | [primary-agent-api §GET](./primary-agent-api.md) |
| POST   | `/api/primary-agent/config`            | upsert 配置（内部/调试，前端改走 WS configure_primary_agent） | [primary-agent-api §config](./primary-agent-api.md) |
| POST   | `/api/primary-agent/start`             | 启 driver（内部/调试，应用启动自动拉起）                | [primary-agent-api §start](./primary-agent-api.md) |
| POST   | `/api/primary-agent/stop`              | 停 driver（内部/调试，应用退出自动停）                   | [primary-agent-api §stop](./primary-agent-api.md) |

### 2.8 Turn 快照 + 冷历史 ⚠️ 前端已改走 WS（下列 HTTP 仅内部/调试）

> **前端迁移**：主 Agent 只有 WS 一个数据源。查内存快照走 WS `get_turns`；查冷历史走 WS `get_turn_history`。详见 [turn-events §4 快照查询](./turn-events.md) 与 [turn-events §8 冷历史接口](./turn-events.md)。

| 方法 | 路径 | 一句话 | 详细 |
|---|---|---|---|
| GET    | `/api/panel/driver/:driverId/turns`    | 拉 `{ active, recent }` turn 内存快照（仅内部/调试，前端改走 WS `get_turns`） | [turn-events §4 快照查询](./turn-events.md) |
| GET    | `/api/panel/driver/:driverId/turn-history` | 持久化冷历史翻页（仅内部/调试，前端改走 WS `get_turn_history`） | [turn-events §8 冷历史接口](./turn-events.md) |

### 2.9 Panel 门面层（前端**唯一**入口）

> **前端 fetch 的 URL 前缀一律是 `/api/panel/`**，不直接调底层 `/api/teams`、`/api/role-instances`、`/api/primary-agent`、`/api/cli` 等。Panel 层做薄转发，无额外业务逻辑；子路径语义与底层完全一致，错误码/响应体/方法校验全部由底层决定。
>
> **8 条映射一览**：
>
> ```
> /api/panel/teams          → /api/teams              (整树转发)
> /api/panel/instances      → /api/role-instances     (整树转发)
> /api/panel/messages       → /api/messages           (仅 POST 发送)
> /api/panel/mcp-tools      → /api/mcp-tools          (工具搜索)
> /api/panel/roster         → /api/roster             (整树转发)
> /api/panel/templates      → /api/role-templates     (整树转发)
> /api/panel/primary-agent  → /api/primary-agent      (整树转发)
> /api/panel/cli            → /api/cli                (整树转发)
> /api/panel/avatars        → /api/avatars            (整树转发)
> /api/panel/action-items   → /api/action-items       (整树转发)
> /api/panel/driver/:id/turns                         (见 §2.8，Turn 内存快照；前端改走 WS get_turns)
> /api/panel/driver/:id/turn-history                  (见 §2.8，Turn 冷历史翻页；前端改走 WS get_turn_history)
> ```
>
> **数字员工没有 HTTP 映射**：前端 workers 数据走 WS `get_workers` / `get_worker_activity`（见 §1.1 / §1.2 / [workers-api.md](./workers-api.md)）。

| 方法 | 路径 | 转发目标 | 一句话 |
|---|---|---|---|
| GET    | `/api/panel/teams`              | `/api/teams`              | 列所有 team |
| GET    | `/api/panel/teams/:id`          | `/api/teams/:id`          | team 详情（含成员） |
| *      | `/api/panel/teams/*`            | `/api/teams/*`            | 完整团队 CRUD 透传 |
| GET    | `/api/panel/instances`          | `/api/role-instances`     | 列所有实例 |
| *      | `/api/panel/instances/*`        | `/api/role-instances/*`   | 完整实例 CRUD 透传（POST/DELETE/:id activate/request-offline） |
| POST   | `/api/panel/messages`           | `/api/messages/send`      | 前端发消息给 agent |
| GET    | `/api/panel/mcp-tools`          | `/api/mcp-tools/search`   | 工具搜索（需 `instanceId` + `q`） |
| GET    | `/api/panel/mcp/tools`          | `/api/mcp-tools/search`   | 等同上（旧路径保留） |
| GET    | `/api/panel/mcp/store`          | `/api/mcp-store`          | 列 MCP 配置 |
| POST   | `/api/panel/mcp/store/install`  | 待开放                    | MCP 安装暂走后端脚本 |
| DELETE | `/api/panel/mcp/store/:name`    | 待开放                    | MCP 卸载暂走后端脚本 |
| GET    | `/api/panel/roster`             | `/api/roster`             | 花名册 |
| *      | `/api/panel/roster/*`           | `/api/roster/*`           | 完整花名册 CRUD 透传（search / :id / :id/alias） |
| GET    | `/api/panel/templates`          | `/api/role-templates`     | 列模板 |
| *      | `/api/panel/templates/*`        | `/api/role-templates/*`   | 完整模板 CRUD 透传（POST/:name GET/PUT/DELETE） |
| GET    | `/api/panel/primary-agent`      | `/api/primary-agent`      | 总控当前配置（未配置返回 `null`） |
| POST   | `/api/panel/primary-agent/config` | `/api/primary-agent/config` | upsert 配置（切 cliType 会自动 stop→start） |
| POST   | `/api/panel/primary-agent/start`  | `/api/primary-agent/start`  | 启 driver（409 already running / 400 not configured / 400 cli 不可用） |
| POST   | `/api/panel/primary-agent/stop`   | `/api/primary-agent/stop`   | 停 driver（409 not running） |
| GET    | `/api/panel/cli`                | `/api/cli`                | CLI 快照（不触发扫描） |
| POST   | `/api/panel/cli/refresh`        | `/api/cli/refresh`        | 立即重新扫描 + diff，返回最新快照 |
| GET    | `/api/panel/avatars`            | `/api/avatars`            | 列所有可见头像 |
| POST   | `/api/panel/avatars`            | `/api/avatars`            | 添加自定义头像（只注册 DB 记录） |
| DELETE | `/api/panel/avatars/:id`        | `/api/avatars/:id`        | 删除/隐藏头像（内置软删、自定义真删） |
| POST   | `/api/panel/avatars/restore`    | `/api/avatars/restore`    | 还原所有被隐藏的内置头像 |
| GET    | `/api/panel/avatars/random`     | `/api/avatars/random`     | 随机返回一个可见头像 |
| POST   | `/api/panel/action-items`             | `/api/action-items`             | 创建待办 |
| GET    | `/api/panel/action-items`             | `/api/action-items`             | 列表（assigneeId/creatorId/status 过滤） |
| GET    | `/api/panel/action-items/:id`         | `/api/action-items/:id`         | 查单个 |
| PUT    | `/api/panel/action-items/:id/resolve` | `/api/action-items/:id/resolve` | 解决（done/rejected） |
| PUT    | `/api/panel/action-items/:id/cancel`  | `/api/action-items/:id/cancel`  | 取消 |
| GET    | `/api/panel/driver/:id/turns`   | —（独立实现）             | Turn 内存快照（**仅内部/调试**；前端走 WS `get_turns`，见 §2.8） |
| GET    | `/api/panel/driver/:id/turn-history` | —（独立实现）        | Turn 冷历史翻页（**仅内部/调试**；前端走 WS `get_turn_history`，见 §2.8） |

---

## 3. 核心数据结构速查

| 名称 | 出现在 | 一句话 | 链接 |
|---|---|---|---|
| `MessageEnvelope` | HTTP 响应 / DB 落库       | 一条消息的完整结构（id/from/to/summary/content/kind/ts/readAt/…） | [messages-api §types](./messages-api.md) |
| `InboxSummary`    | inbox / team history HTTP  | envelope 的 summary 粒度投影（无 content）                        | [messages-api §types](./messages-api.md) |
| `RoleInstance`    | instances HTTP            | 角色实例（id/memberName/status/teamId/task/…）                   | [instances-api §types](./instances-api.md) |
| `RosterEntry`     | roster HTTP               | 花名册条目（含 alias 备注名）                                     | [roster-api §types](./roster-api.md) |
| `TeamRow` / `TeamWithMembers` / `TeamByInstance` | teams HTTP | 团队及成员                                | [teams-api §types](./teams-api.md) |
| `RoleTemplate`    | templates HTTP            | 角色模板（含 `availableMcps`: `{name,surface,search}`）           | [templates-and-mcp §types](./templates-and-mcp.md) |
| `McpConfig`       | mcp-store HTTP            | MCP 服务器配置                                                    | [templates-and-mcp §types](./templates-and-mcp.md) |
| `CliInfo`         | cli HTTP                  | CLI 可用性快照                                                    | [templates-and-mcp §types](./templates-and-mcp.md) |
| `AvatarRow`       | avatars HTTP              | 头像记录（id/filename/builtin/hidden/createdAt）                 | [avatars-api §types](./avatars-api.md) |
| `ActionItem` / `ActionItemKind` / `ActionItemStatus` / `ActorId` | action-items HTTP + WS | 待办（4 kind × 6 status，creator/assignee 都是 ActorId）          | [action-items-api §types](./action-items-api.md) |
| `WorkerView` / `WorkerStatus` / `WsGetWorkersResponse` / `WsGetWorkerActivityResponse` | WS `get_workers*` 响应 | 数字员工视图（= 角色模板聚合投影）+ 活跃度统计                  | [workers-api §types](./workers-api.md) |
| `PrimaryAgentRow` | primary-agent HTTP        | 总控配置（`mcpConfig`: `{serverName,mode,tools?}`，和模板不同！） | [primary-agent-api §types](./primary-agent-api.md) |
| `Turn` / `TurnBlock` | WS `turn.*` / HTTP 快照 | Agent 工作流聚合块，按 `blockId` upsert                           | [turn-events §types](./turn-events.md) |
| `NotificationConfig` / `ProxyMode` / `CustomRule` | 通知配置 | 通知代理策略（proxy_all/direct/custom）                          | [notification-config §types](./notification-config.md) · [notification-and-visibility.md](./notification-and-visibility.md) |
| `VisibilityRule`  | 可见性配置（建议端点）     | principal/target/effect，deny 优先                                | [notification-and-visibility §VisibilityRule](./notification-and-visibility.md) |

---

## 4. 典型场景速查

| 场景 | 入口 | 链路概览 |
|------|------|---------|
| 用户给 agent 发消息             | WS `prompt`（首选）或 `POST /api/messages/send` | `CommRouter.dispatch` → DB + agent stdin + WS 广播 |
| 看 agent 工作过程               | 订阅 `instance` scope + 消费 `turn.*`            | 先 WS `get_turns { driverId, limit:20 }` 拉快照，再 `subscribe` 订阅 |
| 看 agent 之间对话               | 订阅 `instance` 或 `team` scope + 消费 `comm.message_sent` | 按 messageId 幂等合并；正文用 `GET /api/messages/:id` 拉 |
| 列所有人、给实例起备注名       | `GET /api/roster` + `PUT /api/roster/:id/alias` | — |
| 创建成员                        | `POST /api/role-instances`                       | subscriber 自动启 driver + 同步 roster |
| 成员下线（用户发起）           | `POST /api/role-instances/:id/request-offline`   | header `X-Role-Instance-Id` 带调用者 id；`?force=1` 可绕过 |
| 起总控                          | `POST /api/primary-agent/config` → `.../start`   | 先配再起；WS 订 `instance:<PrimaryAgentRow.id>` 收 `turn.*` |
| 断线重连                        | WS `get_turns { driverId, limit:20 }` → WS `subscribe` 带 `lastMsgId` | 主 Agent 只有 WS 一个数据源；先 `get_turns` 拉快照再订阅，`gap-replay` 保证排在实时 event 前 |
| 查看历史对话（上滑加载）       | WS `get_turn_history { driverId, limit:20, beforeEndTs?, beforeTurnId? }` → 翻页带游标 | 返回 `{items, hasMore, nextCursor}`，keyset 分页 |
| 创建待办 / 审批请求             | `POST /api/panel/action-items`（kind=task/approval/decision/authorization）| 收到 `action_item.created` 推送；assignee 到期前收 `action_item.reminder`，超时收 `action_item.timeout` |
| 查看待办列表                    | `GET /api/panel/action-items?assigneeId=local` 或 `?creatorId=xxx` | 无过滤时只返回未完结项（pending+in_progress）；按 deadline ASC 排 |
| 解决 / 取消待办                 | `PUT /api/panel/action-items/:id/resolve {status:done\|rejected}` 或 `/cancel` | 都会 emit `action_item.resolved`，`outcome` ∈ done/rejected/cancelled |

---

## 5. 前端禁调接口（黑名单）

> **总规则**：第 1–4 节列出的就是前端**唯一**可以调的接口集合。**本节列出的全部接口，前端一律不得调用，仅后端内部 / agent 进程 / 部署脚本使用。** 前端若发现需要调用下方接口中的某一条，先停下来找后端，不要自行绕过。
>
> 分 5 类：HTTP 内部路径、非 HTTP 通道（Unix Socket / MCP HTTP）、Agent MCP 工具、未挂路由的建议端点、不向前端广播的 bus 事件。

### 5.1 HTTP 接口：前端禁调（属于 agent / 后端 subscriber / 门面层背后的底层 handler）

> 下表分两类：
> - **(a) agent / 后端专属路径** — 前端永远没资格调；
> - **(b) 门面层背后的底层 `/api/*`** — 有对应的 `/api/panel/*` 门面路径，前端必须走门面。直接打底层会绕过门面层（未来可能加鉴权/审计/限流），发现即按违规处理。

**(a) agent / 后端专属**

| 路径 | 方法 | 真正调用方 | 前端禁调理由 |
|---|---|---|---|
| `/api/sessions/register`          | POST   | **agent 容器内 bootstrap 脚本** | 注册 `claudeSessionId` 并把实例从 PENDING 推进 ACTIVE。由 agent 进程自己回调；前端不持有 sessionId，调了会把别的 agent 推活或写错 session。|
| `/api/roster` (POST)              | POST   | 后端 instance 创建 subscriber   | 前端创建实例走 `POST /api/panel/instances`（→ `/api/role-instances`），roster 由 subscriber 自动同步。直接 POST roster 会绕过实例层，roster 和 role-instances 表失配。|

**(b) 门面层背后的底层 handler（前端走 /api/panel/）**

| 底层路径 | 方法 | 前端改走 | 说明 |
|---|---|---|---|
| `/api/teams[/*]`                 | *   | `/api/panel/teams[/*]`           | 团队 CRUD 整树已被 `/api/panel/teams/*` 门面代理。 |
| `/api/role-instances[/*]`        | *   | `/api/panel/instances[/*]`       | 实例 CRUD 整树。 |
| `/api/messages/send`             | POST| `/api/panel/messages`            | 发消息走门面（GET 查询端点暂未进门面，前端如需要请和后端对齐后再扩）。 |
| `/api/roster[/*]` (GET/PUT/DEL)  | *   | `/api/panel/roster[/*]`          | 花名册读/改走门面。 |
| `/api/role-templates[/*]`        | *   | `/api/panel/templates[/*]`       | 模板 CRUD 整树。 |
| `/api/mcp-store[/*]`             | *   | `/api/panel/mcp/store`           | MCP 商店（目前门面只暴露 GET 列表；写操作暂走后端脚本）。 |
| `/api/mcp-tools/search`          | GET | `/api/panel/mcp-tools` 或 `/api/panel/mcp/tools` | agent 和前端共用同个 handler，前端必须走门面。 |
| `/api/cli[/*]`                   | *   | `/api/panel/cli[/*]`             | CLI 快照 / refresh 走门面。 |
| `/api/primary-agent[/*]`         | *   | `/api/panel/primary-agent[/*]`   | 总控生命周期（GET / POST config / POST start / POST stop）走门面。 |
| `/api/panel/driver/:id/turns`        | GET | WS `get_turns`                 | 主 Agent 只有 WS 一个数据源。HTTP 端点仅内部/调试保留，前端禁调。 |
| `/api/panel/driver/:id/turn-history` | GET | WS `get_turn_history`          | 同上：前端查冷历史走 WS `get_turn_history`，HTTP 端点仅内部/调试保留。 |

### 5.2 非 HTTP 通道：前端绝对触达不到

> 这些通道不走 HTTP/WS，前端（浏览器/Electron renderer）物理上也到不了；列在这里是为了让前端**不要尝试自己实现 agent 端的协议**去"绕开"后端。

| 通道 | 谁用 | 禁调理由 |
|---|---|---|
| **comm Unix Socket**（`CommServer.start(socketPath)`，`packages/backend/src/comm/server.ts`） | agent 子进程 stdio 通信 / legacy socket 客户端 | 后端内部 agent↔hub 通信通道。前端发消息走 WS `prompt` 或 `POST /api/messages/send`，由 `CommRouter.dispatch` 统一落 DB 再广播。前端**不要**直接连 Unix Socket 模拟 agent。|
| **MCP HTTP `/mcp/mteam`**（`packages/backend/src/mcp-http/index.ts`，Streamable HTTP Server） | 沙箱/容器内**成员/Leader agent** 反向访问 | 提供成员 agent 的 `send_msg` / `read_message` / `request_offline` 工具入口。前端**不调此路径**；想发消息用 `/api/messages/send`，想发消息指令用 WS `prompt`。|
| **MCP HTTP `/mcp/mteam-primary`**（同上）                    | 沙箱/容器内**主 Agent** 反向访问 | 主 Agent 专属 MCP，提供 `create_leader` / `send_to_agent` / `list_addresses` / `get_team_status` 4 个工具。前端**不调**。|
| **MCP HTTP `/mcp/searchTools`**                              | 沙箱/容器内 agent | Agent 的 `searchTools` MCP 工具入口，对接 `/api/mcp-tools/search`。前端**不调**。|
| **bus EventBus `emit/subscribe` 直接订阅**                   | 后端模块（notification / turn-aggregator / ws-broadcaster 等 subscriber） | 前端只能通过 WS 间接订阅，且 WS 会剥 `source`/`correlationId` 并按白名单过滤。前端**不存在**直接订阅 EventBus 的途径 —— 任何看似"更早/更全"的事件都只能通过 WS 拿到。|

### 5.3 Agent MCP 工具：前端不调（概念上不是 HTTP 端点）

> 这些是 agent 在自己进程里通过 ACP tool_call 触发的 MCP 工具，不对前端开放。前端若看到消息里提到这些工具名，只当作 agent 行为日志看，不要尝试自己调。
>
> 注意区分两套 MCP：**mteam**（成员/Leader agent 用）和 **mteam-primary**（主 Agent 专属）。主 Agent 不再使用 mteam，改用 mteam-primary + searchTools + mnemo。

**mteam MCP（成员/Leader agent 用）**

| 工具名 | 调用方 | 前端对应入口 |
|---|---|---|
| `send_msg`          | 成员/Leader agent  | 前端用 `POST /api/messages/send` 或 WS `prompt` |
| `read_message`      | 成员/Leader agent  | 前端用 `GET /api/messages/:id` |
| `request_offline`   | Leader agent       | 前端用 `POST /api/role-instances/:id/request-offline` |
| `searchTools`       | 所有 agent         | 前端若有搜索工具 UI，联系后端开独立端点（见 5.1） |

**mteam-primary MCP（主 Agent 专属）**

| 工具名 | 调用方 | 一句话 |
|---|---|---|
| `create_leader`     | 主 Agent           | 创建 Leader 实例 + 自动建团队 |
| `send_to_agent`     | 主 Agent           | 给任意 agent 发消息（跨团队通信总机） |
| `list_addresses`    | 主 Agent           | 查看所有 agent 通信地址（通讯录） |
| `get_team_status`   | 主 Agent           | 查某团队健康度和成员状态 |

### 5.4 建议端点但**未挂 HTTP 路由**（前端调会 404）

前端在"正式挂载"前不要实现调用逻辑；若 UI 方案依赖这些，先和后端对齐时间窗。

| 路径 | 方法 | 状态 | 详细 |
|---|---|---|---|
| `/api/notification/config`                | GET / PUT | **未挂载**，仅有 DAO `notification-store.ts` | [notification-config §4](./notification-config.md) |
| 可见性规则 CRUD（路径未定，设想 `/api/visibility/rules`）| — | **未挂载**，仅有 `filter/types.ts` 类型定义 | [notification-and-visibility §5](./notification-and-visibility.md) |

### 5.5 不向前端广播的 bus 事件（订了也收不到）

| 事件 type / 字段 | 谁消费 | 前端拿不到的理由 |
|---|---|---|
| `driver.thinking` / `driver.text` / `driver.tool_call` / `driver.tool_result` / `driver.turn_done` | 后端 `turn-aggregator` 聚合成 `turn.*` | 已从 WS 白名单移除，前端改用 `turn.block_updated` / `turn.completed`。|
| 外层 `source` 字段                      | 后端 subscriber 调试用   | WS 广播前剥除，前端不可见也不可依赖。|
| 外层 `correlationId` 字段               | 后端跨事件串联用         | 同上。前端去重用 `eventId` / `messageId`。|
| bus 上一切未列入 `WS_EVENT_TYPES` 白名单的事件 | 后端内部 subscriber | 未进白名单即使 emit 了也不下发前端。新增事件要走白名单申请。|

### 5.6 判定原则（收敛）

> **在第 1–4 节里能找到的就是前端能调的；找不到就是禁调的。** 遇到新 feature：
> - 先查 INDEX 第 1–4 节；查不到就别发 —— 找后端确认要挂新端点还是走现有入口。
> - 看到 agent 侧的 MCP 工具名（`send_msg` / `searchTools` …）不要自行调，找对应的前端 HTTP/WS 入口。
> - 看到文档里写"仅 DAO / 未挂路由"一律当 404 看。

---

## 6. 子文档导航

| 文档 | 内容 |
|---|---|
| [ws-protocol.md](./ws-protocol.md)                           | WebSocket 协议全契约（上行/下行/错误码） |
| [bus-events.md](./bus-events.md)                             | 全部 bus 事件字段表 |
| [turn-events.md](./turn-events.md)                           | `turn.*` 聚合块前端渲染对接 |
| [message-flow.md](./message-flow.md)                         | 三路分发（DB / agent stdin / WS）总览与 4 种入口场景 |
| [messages-api.md](./messages-api.md)                         | 消息 HTTP 接口 |
| [instances-api.md](./instances-api.md)                       | 角色实例生命周期 HTTP |
| [roster-api.md](./roster-api.md)                             | 花名册 HTTP |
| [teams-api.md](./teams-api.md)                               | 团队 HTTP |
| [templates-and-mcp.md](./templates-and-mcp.md)               | 模板 / MCP 商店 / CLI 扫描 / MCP 工具搜索 |
| [avatars-api.md](./avatars-api.md)                           | 头像库 CRUD + 随机 |
| [action-items-api.md](./action-items-api.md)                 | 待办（task/approval/decision/authorization）HTTP + WS |
| [workers-api.md](./workers-api.md)                           | 数字员工（角色模板视图）列表 + 活跃度（WS `get_workers` / `get_worker_activity`） |
| [primary-agent-api.md](./primary-agent-api.md)               | 总控 Agent 生命周期 HTTP + WS 联动 |
| [sessions-and-auth.md](./sessions-and-auth.md)               | WS `userId` 约定 / user scope 越权 / sessions/register |
| [notification-and-visibility.md](./notification-and-visibility.md) | 通知代理 + 可见性过滤机制 |
| [notification-config.md](./notification-config.md)           | 通知配置 TS 类型与建议 HTTP |
| [../architecture-overview.md](../architecture-overview.md)    | 整体架构（后端视角，前端对接前可通读） |
