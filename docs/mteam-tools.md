# mteam MCP 工具完整清单

mteam 是 mcp-team-hub 内置 MCP server，通过 stdio 为 agent 提供团队协作工具。

---

## 已有工具

### 1. activate

| 属性 | 值 |
|------|-----|
| 角色 | member 专属 |
| 首屏建议 | member: 首屏; leader: 隐藏 |
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

### 8. remove_member

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 次屏 |
| leaderOnly | true |

**功能**: leader 从 team 移除成员并删除实例。先 request_offline，再 delete。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {
    "instanceId": { "type": "string", "description": "目标成员 instanceId" },
    "force":      { "type": "boolean", "default": false, "description": "强制删除（跳过下线流程）" }
  },
  "required": ["instanceId"],
  "additionalProperties": false
}
```

**回调 backend API**:
1. `DELETE /api/teams/:teamId/members/:instanceId`
2. `DELETE /api/role-instances/:id?force=0|1`

---

### 9. list_members

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 首屏 |
| leaderOnly | true |

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

### 10. disband_team

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 次屏 |
| leaderOnly | true |

**功能**: leader 解散当前 team。所有成员被通知下线。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {
    "confirm": { "type": "boolean", "description": "确认解散" }
  },
  "required": ["confirm"],
  "additionalProperties": false
}
```

**回调 backend API**: `POST /api/teams/:teamId/disband`

---

### 11. assign_task

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 首屏 |
| leaderOnly | true |

**功能**: leader 给成员分配/更新任务。通过 send_msg 推送任务内容给目标成员。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {
    "instanceId": { "type": "string", "description": "目标成员 instanceId" },
    "task":       { "type": "string", "description": "任务描述" }
  },
  "required": ["instanceId", "task"],
  "additionalProperties": false
}
```

**回调 backend API**: send_msg 通信通道（comm socket） + 可选 `PATCH /api/role-instances/:id`（如有任务字段更新）

---

### 12. broadcast

| 属性 | 值 |
|------|-----|
| 角色 | leader 专属 |
| 首屏建议 | 次屏 |
| leaderOnly | true |

**功能**: leader 向 team 全体成员广播消息。

**inputSchema**:

```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string", "maxLength": 200, "description": "摘要" },
    "content": { "type": "string", "description": "消息体" }
  },
  "required": ["summary", "content"],
  "additionalProperties": false
}
```

**回调 backend API**: `GET /api/teams/:teamId/members` 获取成员列表 → 逐个 comm.send

---

## 完整工具矩阵

| # | 工具名 | 角色 | 首屏/次屏 | 状态 | 说明 |
|---|--------|------|-----------|------|------|
| 1 | `activate` | member | member 首屏 / leader 隐藏 | 已实现 | 成员自激活 |
| 2 | `deactivate` | member | 次屏 | 已实现 | 成员下线 |
| 3 | `send_msg` | 公共 | 首屏 | 已实现 | 点对点消息 |
| 4 | `check_inbox` | 公共 | 首屏 | 已实现 | 拉取未读消息 |
| 5 | `lookup` | 公共 | 次屏 | 已实现 | 模糊查找通信目标 |
| 6 | `request_offline` | leader | 次屏 | 已实现 | 批准成员下线 |
| 7 | `add_member` | leader | 首屏 | 待实现 | 添加成员到 team |
| 8 | `remove_member` | leader | 次屏 | 待实现 | 从 team 移除成员 |
| 9 | `list_members` | leader | 首屏 | 待实现 | 查看 team 成员列表 |
| 10 | `disband_team` | leader | 次屏 | 待实现 | 解散 team |
| 11 | `assign_task` | leader | 首屏 | 待实现 | 分配任务给成员 |
| 12 | `broadcast` | leader | 次屏 | 待实现 | 全体广播 |

---

## leader 自动化说明

### team 自动创建

leader 实例通过 `POST /api/role-instances`（`isLeader: true`）创建时，后端 `RoleInstance.create()` 自动创建 team 并写入 `instance.teamId`。**不需要 `create_team` 工具**。

### leader 自动激活

leader 的 agent 进程启动后，pty 输出检测（心跳/首行输出）自动将 leader 从 PENDING -> ACTIVE。**leader 不需要手动调用 `activate`**。

### activate 对 leader 的处理

`activate` 工具的 `leaderOnly: false` 意味着 leader 技术上能调用它，但 leader 不需要。建议在角色模板的 MCP 工具可见性配置中，将 `activate` 对 leader 角色设为隐藏（不出现在 surface 也不出现在 search），避免误用。member 必须首屏展示，因为这是 member CLI 启动后的第一个必调工具。
