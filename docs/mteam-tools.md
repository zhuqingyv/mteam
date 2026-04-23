# mteam MCP 工具完整清单

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

### ~~8. remove_member~~ — 暂不实现

leader 不允许直接清除成员。成员下线走 request_offline 流程（leader 批准 → 成员进入 PENDING_OFFLINE → 成员自行 deactivate）。

---

### 9. list_members

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

### ~~10. disband_team~~ — 暂不实现

leader 下线 team 自动消失（生命周期联动已实现）。leader 在 team 就在，没有主动解散场景。

---

### ~~11. assign_task~~ — 暂不实现

send_msg 已能覆盖。leader 给成员发消息即分配任务。

---

### ~~12. broadcast~~ — 暂不实现

send_msg 逐个发即可。后续如有需要再加。

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
| 8 | ~~`remove_member`~~ | — | — | 暂不实现 | 走 request_offline |
| 9 | `list_members` | 公共 | 首屏 | **待实现** | 查看 team 成员列表 |
| 10 | ~~`disband_team`~~ | — | — | 暂不实现 | leader 下线 team 自动消失 |
| 11 | ~~`assign_task`~~ | — | — | 暂不实现 | send_msg 覆盖 |
| 12 | ~~`broadcast`~~ | — | — | 暂不实现 | send_msg 逐个发 |

---

## leader 自动化说明

### team 自动创建

leader 实例通过 `POST /api/role-instances`（`isLeader: true`）创建时，后端 `RoleInstance.create()` 自动创建 team 并写入 `instance.teamId`。**不需要 `create_team` 工具**。

### leader 自动激活

leader 的 agent 进程启动后，pty 输出检测（心跳/首行输出）自动将 leader 从 PENDING -> ACTIVE。**leader 不需要手动调用 `activate`**。

### activate 对 leader

leader 自动激活，`activate` 在 leader 的角色模板 MCP 配置里不存在。member 必须首屏展示。
