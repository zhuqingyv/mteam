# 前端接入索引

所有后端接口文档在 `docs/frontend-api/`（项目根）。本文件是前端开发的**唯一入口** — 按模块分工，每个 agent 读自己负责的文档就能干活。

---

## 总览

先读这份，了解全局能力：

| 文档 | 路径 | 读完知道什么 |
|------|------|------------|
| **接口总览** | [docs/frontend-api/INDEX.md](../../../docs/frontend-api/INDEX.md) | 全部 WS + HTTP 接口白名单/黑名单 |
| **架构总览** | [packages/backend/docs/architecture-overview.md](../../backend/docs/architecture-overview.md) | 系统全貌 |

---

## 按模块分工

### 模块 1：WS 连接层

**职责**：建连、心跳、订阅、断线重连

| 文档 | 路径 |
|------|------|
| WS 协议 | [docs/frontend-api/ws-protocol.md](../../../docs/frontend-api/ws-protocol.md) |
| Session 认证 | [docs/frontend-api/sessions-and-auth.md](../../../docs/frontend-api/sessions-and-auth.md) |

**接入要点**：
- 连接 `ws://localhost:58590/ws/events?userId=xxx`
- 收 `snapshot` → 初始化主 Agent 状态
- 发 `subscribe(global)` 开始收事件
- 心跳 `ping` / `pong` 30s
- 断线 → 重连 → 重新 subscribe

---

### 模块 2：主 Agent 状态 + 对话

**职责**：主 Agent 在线/离线、thinking/responding/idle、发消息、看回复

| 文档 | 路径 |
|------|------|
| 主 Agent API | [docs/frontend-api/primary-agent-api.md](../../../docs/frontend-api/primary-agent-api.md) |
| Turn 事件（对话渲染） | [docs/frontend-api/turn-events.md](../../../docs/frontend-api/turn-events.md) |

**接入要点**：
- **主 Agent 只有 WS 一个数据源**：连接状态、工作状态、发消息、看回复、切 CLI、断线恢复、冷历史翻页，统统走同一条 WS。不调任何 HTTP turn/primary-agent 端点。
- 连接状态：`snapshot.primaryAgent.status` (`RUNNING`/`STOPPED`)
- 工作状态：`primary_agent.state_changed` (`idle`/`thinking`/`responding`)
- 发消息：WS `{op:'prompt', instanceId, text}`
- 看回复：`turn.started` → `turn.block_updated`(thinking/text/tool_call) → `turn.completed`
- 切 CLI：WS `{op:'configure_primary_agent', cliType:'codex'}`
- 断线恢复：WS `{op:'get_turns', driverId, limit:20, requestId}` → 收 `get_turns_response` 拉内存快照
- 历史翻页：WS `{op:'get_turn_history', driverId, limit:20, beforeEndTs?, beforeTurnId?, requestId}` → 收 `get_turn_history_response`（keyset 分页，上滑加载）
- **主 Agent MCP 能力**（前端不直接调，但需知道主 Agent 能做什么）：主 Agent 使用 **mteam-primary** MCP（`create_leader` / `send_to_agent` / `list_addresses` / `get_team_status`）+ searchTools + mnemo。不使用 mteam（成员/Leader 工具集）。

---

### 模块 3：聊天消息

**职责**：消息列表、历史翻页、已读（agent 间通信的消息）

| 文档 | 路径 |
|------|------|
| 消息 API | [docs/frontend-api/messages-api.md](../../../docs/frontend-api/messages-api.md) |
| 消息三路分发 | [docs/frontend-api/message-flow.md](../../../docs/frontend-api/message-flow.md) |

**接入要点**：
- **用户和 agent 聊天**：WS `{op:'prompt'}` 直达 agent，不走消息系统（见模块 2）
- **agent 间通信消息**：WS 事件 `comm.message_sent` / `comm.message_received`
- 查历史：HTTP `GET /api/panel/teams/:id/messages?before=&limit=50`
- 去重靠 `envelope.id`
- HTTP `POST /api/panel/messages` 是**内部/调试接口**，前端用户聊天不走这个

---

### 模块 4：团队管理

**职责**：团队列表、创建/解散、成员管理

| 文档 | 路径 |
|------|------|
| 团队 API | [docs/frontend-api/teams-api.md](../../../docs/frontend-api/teams-api.md) |
| 实例 API | [docs/frontend-api/instances-api.md](../../../docs/frontend-api/instances-api.md) |

**接入要点**：
- HTTP CRUD：`/api/panel/teams` + `/api/panel/instances`
- 实时事件：`team.created` / `team.disbanded` / `team.member_joined` / `team.member_left`
- 实例状态：`instance.created` / `instance.activated` / `instance.deleted`

---

### 模块 5：花名册 + 搜索

**职责**：成员列表、搜索、备注名

| 文档 | 路径 |
|------|------|
| 花名册 API | [docs/frontend-api/roster-api.md](../../../docs/frontend-api/roster-api.md) |

**接入要点**：
- HTTP：`/api/panel/roster` + `/api/panel/roster/search?q=`
- 实时：WS 事件 `comm.registered` / `comm.disconnected`

---

### 模块 6：模板 + MCP + CLI

**职责**：角色模板管理、MCP 工具安装、CLI 状态

| 文档 | 路径 |
|------|------|
| 模板与 MCP | [docs/frontend-api/templates-and-mcp.md](../../../docs/frontend-api/templates-and-mcp.md) |

**接入要点**：
- HTTP CRUD：`/api/panel/templates` + `/api/panel/mcp-tools`
- CLI 状态：`/api/panel/cli`
- 实时：`template.*` / `mcp.*` / `cli.*` 事件

---

### 模块 6a：头像库

**职责**：头像列表、添加/删除/还原、随机选择

| 文档 | 路径 |
|------|------|
| 头像 API | [docs/frontend-api/avatars-api.md](../../../docs/frontend-api/avatars-api.md) |

**接入要点**：
- HTTP CRUD：`/api/panel/avatars`
- 20 个内置头像在 `src/assets/avatars/avatar-01~20.png`（128x128 透明背景像素风）
- 内置头像删除只隐藏，还原可恢复；自定义头像删除真删
- 角色模板的 avatar 字段对应头像库的 id

---

### 模块 7：通知 + 可见性

**职责**：通知设置（三种代理模式）、可见性规则

| 文档 | 路径 |
|------|------|
| 通知配置 | [docs/frontend-api/notification-config.md](../../../docs/frontend-api/notification-config.md) |
| 可见性规则 | [docs/frontend-api/notification-and-visibility.md](../../../docs/frontend-api/notification-and-visibility.md) |

**接入要点**：
- 通知事件：`notification.delivered`（按 sourceEventId 去重）
- 配置 API：待落地（当前只有 DAO，HTTP 端点 TODO）

---

### 模块 8：事件总表

**职责**：了解所有 WS 推送事件的 payload 结构

| 文档 | 路径 |
|------|------|
| 事件全表 | [docs/frontend-api/bus-events.md](../../../docs/frontend-api/bus-events.md) |

---

## 前端禁调接口

详见 [INDEX.md §5](../../../docs/frontend-api/INDEX.md)。底层接口（`/api/teams` / `/api/role-instances` / comm socket / MCP HTTP）**前端不碰**，全走 `/api/panel/*` 门面层。
