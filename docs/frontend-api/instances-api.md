# Role Instances API

> **面向**：前端 UI / 测试面板（HTTP 调用方）。Agent 侧通过 MCP 工具 `request_offline` 触发下线，最终经由本文档的 `POST /:id/request-offline` 落库，但对 agent 不可见 HTTP 细节。

角色实例的生命周期：创建 / 激活 / 请求下线 / 删除。所有路径以 `/api/role-instances` 为前缀。

后端副作用（driver 启停、roster 同步）全部走 bus subscriber，前端**不需要**额外调用。

## 类型

```ts
type RoleStatus = 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE';

interface RoleInstance {
  id: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  projectId: string | null;
  status: RoleStatus;
  sessionId: string | null;
  sessionPid: number | null;
  claudeSessionId: string | null;
  leaderName: string | null;
  task: string | null;
  createdAt: string; // ISO
}
```

## 状态机

```
PENDING --activate--> ACTIVE --request-offline--> PENDING_OFFLINE
```

删除规则：

- `PENDING` / `PENDING_OFFLINE` 可直接 DELETE
- `ACTIVE` 不能直接 DELETE，必须先 `request-offline`（或用 `?force=1`）
- `?force=1` 走 crash 语义，用于清理脏数据

## 路由一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/role-instances` | 所有实例 |
| POST | `/api/role-instances` | 创建实例（PENDING） |
| DELETE | `/api/role-instances/:id` | 删除（可 `?force=1`） |
| POST | `/api/role-instances/:id/activate` | PENDING → ACTIVE |
| POST | `/api/role-instances/:id/request-offline` | ACTIVE → PENDING_OFFLINE |

---

### GET `/api/role-instances`

返回 `RoleInstance[]`。

### POST `/api/role-instances`

请求：

```json
{
  "templateName": "frontend-engineer",
  "memberName": "Alice",
  "isLeader": false,
  "task": "实现登录页",
  "leaderName": "Bob"
}
```

字段：

- `templateName` 必填，1~64 字符，必须已存在的模板
- `memberName` 必填，1~64 字符
- `isLeader` 可选，默认 `false`
- `task` 可选，≤ 2048 字符
- `leaderName` 可选，≤ 64 字符

返回 `201` + `RoleInstance`（`status = 'PENDING'`）。模板不存在 `404`；校验失败 `400`。

副作用（subscriber 自动做）：

1. member-driver 启动
2. roster 新增该实例
3. `sessionPid` 启动后回写

### DELETE `/api/role-instances/:id?force=1`

返回 `204`。

- 不存在 `404`
- `ACTIVE` 且未 `force` 时 `409`，错误文案：`需要 leader 批准下线`
- 其它非 `PENDING`/`PENDING_OFFLINE` 状态且未 force 时 `409`

### POST `/api/role-instances/:id/activate`

返回 `200` + `RoleInstance`。

- 不存在 `404`
- 状态不是 `PENDING` 时 `409`

**注意**：这是面板/测试走的激活入口，不依赖 session register。正常 agent 启动时由 session 流程自动激活。

### POST `/api/role-instances/:id/request-offline`

> **调用方**：前端 UI（面板按钮，header 传调用者）+ agent MCP 工具 `request_offline`（内部转发到此 HTTP，header 由后端注入）。

Leader 批准某成员下线。

调用者 ID 读取顺序：**header `X-Role-Instance-Id`** > body `callerInstanceId`。前端推荐走 header。

请求 body（header 存在时可为空）：

```json
{ "callerInstanceId": "leader-inst-id" }
```

返回 `200` + `RoleInstance`（`status = 'PENDING_OFFLINE'`）。

错误：

- 目标实例不存在 `404`
- `callerInstanceId` 缺失 `400`
- 调用者不存在 `404`
- 调用者非 leader `403`：`only leader can request offline`
- 目标实例状态不是 `ACTIVE` `409`

## 事件（供 WS 订阅参考）

- `instance.created` — POST `/api/role-instances`
- `instance.activated` — POST `/api/role-instances/:id/activate`
- `instance.offline_requested` — POST `/api/role-instances/:id/request-offline`
- `instance.deleted` — DELETE `/api/role-instances/:id`（带 `previousStatus` / `force` / `teamId` / `isLeader`）

细节见 `bus-events.md`。
