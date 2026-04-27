# mteam / mteam-primary MCP 工具完整清单

> ⛔ **服务端底层接口（MCP stdio 协议 / Streamable HTTP），禁止前端调用**

> **受众**：
> - **Agent（Claude / Codex CLI 子进程）** —— 这些工具通过 MCP stdio 协议暴露给 agent 调用，agent 是唯一消费方。
> - **后端实现者** —— 在 `packages/backend/src/mcp/tools/*.ts`（mteam）和 `packages/backend/src/mcp-primary/tools/*.ts`（mteam-primary）实现 / 维护工具。
>
> **非受众**：
> - **前端开发者** —— 前端既不调用这些工具，也不需要理解 `inputSchema`。文档中列出的「回调 API」是**工具内部**回调后端 HTTP，**不是前端要调用的 API**。前端的消息/成员/团队 HTTP 接口请看 `docs/frontend-api/*`。

## 两套 MCP 的区分

| MCP server | 使用方 | 工具数 | 代码位置 | HTTP 路径 |
|------------|--------|--------|---------|-----------|
| **mteam** | 成员/Leader agent | 8 | `src/mcp/tools/` | `/mcp/mteam`（:58591） |
| **mteam-primary** | 主 Agent（Primary Agent）专属 | 4 | `src/mcp-primary/tools/` | `/mcp/mteam-primary`（:58591） |

**主 Agent 不使用 mteam**（mteam 工具的语义前提是"调用者在 `role_instances` 表中"，主 Agent 不在）。主 Agent 的 MCP 组合：mteam-primary + searchTools + mnemo。

---

## Part A: mteam MCP（成员/Leader agent 用）

mteam 是 mcp-team-hub 内置 MCP server，通过 stdio 为 agent 提供团队协作工具。

---

## 已有工具

### 1. activate

| 属性 | 值 |
|------|-----|
| 角色 | member 专属 |
| 首屏建议 | member: 首屏 |
| leader | 不存在（leader 自动激活，配置里没有此工具） |
| leaderOnly | false |

**功能**: 成员激活自身，PENDING -> ACTIVE。agent CLI 启动后必须首先调用。返回 persona/task/leaderName。

**参数**: 无

**回调 API**: `POST /api/role-instances/:id/activate`

---

### 2. deactivate

| 属性 | 值 |
|------|-----|
| 角色 | member 专属 |
| 首屏建议 | 次屏 |
| leaderOnly | false |

**功能**: 成员离线。前提是 leader 已批准下线（状态必须是 PENDING_OFFLINE），否则报错。

**参数**: 无

**回调 API**: `DELETE /api/role-instances/:id`（带 `X-Role-Instance-Id` header）

---

### 3. send_msg

| 属性 | 值 |
|------|-----|
| 角色 | 公共 |
| 首屏建议 | 首屏 |
| leaderOnly | false |

**功能**: 向另一个 agent 发送消息。`to` 支持地址（`local:<id>`）、alias、member_name、instanceId。多匹配则报错。内部先走 lookup 解析地址，再通过 comm（Unix socket）投递。

**参数**:

```json
{
  "to":      { "type": "string", "description": "目标: 地址/alias/member_name/instanceId" },
  "summary": { "type": "string", "maxLength": 200, "description": "摘要" },
  "content": { "type": "string", "description": "完整消息体" }
}
```

required: `["to", "summary", "content"]`

---

### 4. check_inbox

| 属性 | 值 |
|------|-----|
| 角色 | 公共 |
| 首屏建议 | 首屏 |
| leaderOnly | false |

**功能**: 拉取未读消息。peek=false（默认）标记已读；peek=true 只预览不标记。

**参数**:

```json
{
  "peek": { "type": "boolean", "default": false, "description": "true 则不标记已读" }
}
```

**回调 API**: `GET /api/role-instances/:id/inbox?peek=true|false`

---

### 5. lookup

| 属性 | 值 |
|------|-----|
| 角色 | 公共 |
| 首屏建议 | 次屏 |
| leaderOnly | false |

**功能**: 模糊搜索通信目标。按 alias 匹配（fallback member_name），支持 scope 过滤。

**参数**:

```json
{
  "query": { "type": "string", "description": "关键词，模糊匹配 alias / member_name" },
  "scope": { "type": "string", "enum": ["team", "local", "remote"], "description": "搜索范围" }
}
```

required: `["query"]`

**回调 API**: `GET /api/roster/search?q=xxx&scope=xxx&callerInstanceId=xxx`

---

### 6. request_offline

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 次屏 |
| leaderOnly | true |

**功能**: leader 批准某成员下线。将目标从 ACTIVE -> PENDING_OFFLINE 并通过 comm 通知该成员。

**参数**:

```json
{
  "instanceId": { "type": "string", "description": "目标成员的 role_instances.id" }
}
```

required: `["instanceId"]`

**回调 API**: `POST /api/role-instances/:id/request-offline`（带 `X-Role-Instance-Id` header + body `callerInstanceId`）

---

## 待实现工具

### 7. add_member

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 首屏 |
| leaderOnly | true |

**功能**: leader 向自己的 team 添加成员。创建角色实例 + 加入 team。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {
    "templateName": { "type": "string", "description": "角色模板名" },
    "memberName":   { "type": "string", "description": "成员名" },
    "task":         { "type": "string", "description": "分配任务（可选）" },
    "roleInTeam":   { "type": "string", "description": "团队内角色描述（可选）" }
  },
  "required": ["templateName", "memberName"],
  "additionalProperties": false
}
```

**回调 backend API**:
1. `POST /api/role-instances` — 创建实例（`{ templateName, memberName, isLeader: false, task, leaderName }`）
2. `POST /api/teams/:teamId/members` — 加入 team（`{ instanceId, roleInTeam }`）

---

### 8. list_members

| 属性 | 值 |
|------|-----|
| 角色 | 公共 |
| 首屏建议 | 首屏 |
| leaderOnly | false |

**功能**: 列出当前 team 所有成员及其状态。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**回调 backend API**: `GET /api/teams/:teamId/members`（teamId 从 leader 的 env 推导）

---

## 完整工具矩阵

| # | 工具名 | 角色 | 首屏/次屏 | 状态 | 说明 |
|---|--------|------|-----------|------|------|
| 1 | `activate` | member | member 首屏 | 已实现 | 成员自激活（leader 配置里不存在） |
| 2 | `deactivate` | member | 次屏 | 已实现 | 成员下线 |
| 3 | `send_msg` | 公共 | 首屏 | 已实现 | 点对点消息 |
| 4 | `check_inbox` | 公共 | 首屏 | 已实现 | 拉取未读消息 |
| 5 | `lookup` | 公共 | 次屏 | 已实现 | 模糊查找通信目标 |
| 6 | `request_offline` | leader | 次屏 | 已实现 | 批准成员下线 |
| 7 | `add_member` | leader | 首屏 | **待实现** | 创建成员 instance + 加入 team |
| 8 | `list_members` | 公共 | 首屏 | **待实现** | 查看 team 成员列表 |

---

## leader 自动化说明

### team 自动创建

leader 实例通过 `POST /api/role-instances`（`isLeader: true`）创建时，后端 `RoleInstance.create()` 自动创建 team 并写入 `instance.teamId`。**不需要 `create_team` 工具**。

### leader 自动激活

leader 的 agent 进程启动后，pty 输出检测（心跳/首行输出）自动将 leader 从 PENDING -> ACTIVE。**leader 不需要手动调用 `activate`**。

### activate 对 leader

leader 自动激活，`activate` 在 leader 的角色模板 MCP 配置里不存在。member 必须首屏展示。

---

## Part B: mteam-primary MCP（主 Agent 专属）

> 代码位置：`packages/backend/src/mcp-primary/`
> MCP HTTP 路径：`/mcp/mteam-primary`（:58591）
> 注入方式：`mcpManager.resolveForPrimary()` → `primary-agent/driver-config.ts`

主 Agent（Primary Agent）不在 `role_instances` 表中，不参与任何团队，因此不能使用 mteam MCP。mteam-primary 提供 4 个专属工具，让主 Agent 充当"秘书 + 总机"角色。

---

### 1. create_leader

| 属性 | 值 |
|------|-----|
| 调用方 | 主 Agent 专属 |
| 用途 | 创建 Leader 实例 + 自动建团队 |

**功能**: 用户说"帮我建个团队做 X"时，主 Agent 调用此工具创建一个 Leader 角色实例，后端自动创建 team 并将 Leader 加入。

**参数**:

```json
{
  "templateName": { "type": "string", "description": "角色模板名" },
  "memberName":   { "type": "string", "description": "Leader 显示名" },
  "teamName":     { "type": "string", "description": "团队名" },
  "description":  { "type": "string", "description": "团队描述（可选）" },
  "task":         { "type": "string", "description": "初始任务（可选）" }
}
```

required: `["templateName", "memberName", "teamName"]`

**返回**: `{ instanceId, teamId, memberName, teamName }`

---

### 2. send_to_agent

| 属性 | 值 |
|------|-----|
| 调用方 | 主 Agent 专属 |
| 用途 | 给任意 agent 发消息（跨团队通信总机） |

**功能**: 主 Agent 向任意 agent 发送消息。内部复用 `CommRouter.dispatch()` + `InProcessComm`，envelope 的 `from` 固定为主 Agent 的 `local:<primary_id>` 地址。

**参数**:

```json
{
  "to":      { "type": "string", "description": "address | instanceId | alias" },
  "content": { "type": "string", "description": "消息正文" },
  "summary": { "type": "string", "description": "摘要，≤200 字符（可选）" },
  "kind":    { "type": "string", "enum": ["chat", "task"], "description": "消息类型（可选，默认 chat）" },
  "replyTo": { "type": "string", "description": "引用的 envelopeId（可选）" }
}
```

required: `["to", "content"]`

**返回**: `{ delivered: true, envelopeId }` | `{ error }`

---

### 3. list_addresses

| 属性 | 值 |
|------|-----|
| 调用方 | 主 Agent 专属 |
| 用途 | 查看所有 agent 通信地址（通讯录） |

**功能**: 列出当前所有 agent 的通信地址，支持按角色和团队过滤。

**参数**:

```json
{
  "scope":  { "type": "string", "enum": ["all", "leaders", "members"], "description": "过滤范围（可选，默认 all）" },
  "teamId": { "type": "string", "description": "按团队过滤（可选）" }
}
```

**返回**: `{ entries: [{ address, kind, displayName, instanceId, teamId?, status }], total }`

---

### 4. get_team_status

| 属性 | 值 |
|------|-----|
| 调用方 | 主 Agent 专属 |
| 用途 | 查某团队健康度和成员状态 |

**功能**: 用户问"X 团队做到哪了"时，主 Agent 调用此工具查看团队状态，避免每次都要 `send_to_agent` ping Leader。

**参数**:

```json
{
  "teamId": { "type": "string", "description": "团队 ID" }
}
```

required: `["teamId"]`

**返回**: `{ teamName, leader: { name, status }, members: [{ name, status, task? }], memberCount }`

---

### mteam-primary 完整工具矩阵

| # | 工具名 | 用途 | 状态 |
|---|--------|------|------|
| 1 | `create_leader` | 创建 Leader + 自动建团队 | 已实现 |
| 2 | `send_to_agent` | 跨团队通信总机 | 已实现 |
| 3 | `list_addresses` | 通讯录 | 已实现 |
| 4 | `get_team_status` | 团队健康度查询 | 已实现 |
