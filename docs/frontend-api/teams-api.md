# Teams API

> **面向**：前端 UI（HTTP CRUD 调用方）。本期没有 agent 侧 MCP 工具操作 team（未来可能增加 `team_create` / `team_add_member` 等工具，届时这些 HTTP 成为 agent MCP 的底层实现）；级联清理由后端 subscriber 自动处理，前端不调。

团队与成员关系的 CRUD。所有路径以 `/api/teams` 为前缀。所有 handler 会主动发 bus 事件（见 bus-events 文档）。级联清理（instance 删除时移除成员、解散空 team）由后端 subscriber 自动处理，前端不需要关心。

## 类型

```ts
type TeamStatus = 'ACTIVE' | 'DISBANDED';

interface TeamRow {
  id: string;
  name: string;
  leaderInstanceId: string;
  description: string;
  status: TeamStatus;
  createdAt: string;       // ISO
  disbandedAt: string | null;
}

interface TeamMemberRow {
  id: number;
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
  joinedAt: string;
}

interface TeamWithMembers extends TeamRow {
  members: TeamMemberRow[];
}

// GET /by-instance/:id 的返回，members 已 enrich
interface TeamByInstance {
  teamId: string;
  teamName: string;
  leaderInstanceId: string;
  members: Array<{
    instanceId: string;
    memberName: string | null;
    status: 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE' | null;
    isLeader: boolean;
    roleInTeam: string | null;
    joinedAt: string;
  }>;
}
```

## 路由一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/teams` | 所有 team |
| POST | `/api/teams` | 创建 team |
| GET | `/api/teams/:id` | team 详情（含成员） |
| POST | `/api/teams/:id/disband` | 解散 team |
| GET | `/api/teams/:id/members` | team 成员列表 |
| POST | `/api/teams/:id/members` | 添加成员 |
| DELETE | `/api/teams/:id/members/:instanceId` | 移除成员 |
| GET | `/api/teams/by-instance/:instanceId` | 按实例反查 ACTIVE team |

---

### GET `/api/teams`

返回 `TeamRow[]`。

### POST `/api/teams`

请求：

```json
{ "name": "Alpha", "leaderInstanceId": "inst-1", "description": "optional" }
```

- `name` 必填，1~64 字符
- `leaderInstanceId` 必填
- `description` 可选，默认 `""`

返回 `201` + `TeamRow`。冲突返回 `409`（同 leader 已有 ACTIVE team）。

### GET `/api/teams/:id`

返回 `200` + `TeamWithMembers`；不存在返回 `404`。

### POST `/api/teams/:id/disband`

返回 `204`。不存在 `404`；已解散 `409`。

### GET `/api/teams/:id/members`

返回 `TeamMemberRow[]`；team 不存在 `404`。

### POST `/api/teams/:id/members`

请求：

```json
{ "instanceId": "inst-2", "roleInTeam": "frontend" }
```

- `instanceId` 必填
- `roleInTeam` 可选

返回 `201`：

```json
{ "teamId": "team-1", "instanceId": "inst-2", "roleInTeam": "frontend" }
```

team 不存在 `404`；team 已解散 `409`；其他校验失败 `400`。

### DELETE `/api/teams/:id/members/:instanceId`

返回 `204`（不管是否真的移除了成员）。team 不存在 `404`。

### GET `/api/teams/by-instance/:instanceId`

按实例反查它所在的 ACTIVE team，返回 `TeamByInstance`。不在任何 ACTIVE team 时返回 `404`。members 已带 `memberName`/`status`/`isLeader`，前端可直接渲染，不必再打实例接口。

## 事件（供 WS 订阅参考）

handler 成功时会在 bus 上广播：

- `team.created` — POST `/api/teams`
- `team.disbanded` — POST `/api/teams/:id/disband`
- `team.member_joined` — POST `/api/teams/:id/members`
- `team.member_left` — DELETE `/api/teams/:id/members/:instanceId`（仅在实际移除时）

细节见 `bus-events.md`。
