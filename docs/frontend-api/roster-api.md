# Roster API

> **面向**：前端 UI（列人/搜人/改备注/详情读取）。`POST /api/roster` 由后端 subscriber 自动创建，前端不用主动调。Agent 不调用 roster HTTP。

Role 实例花名册（roster）HTTP 接口。用于前端列人、搜人、改备注。

## 类型定义

```ts
export type RosterScope  = 'local' | 'remote';
export type SearchScope  = 'team' | 'local' | 'remote';

export interface RosterEntry {
  instanceId: string;
  memberName: string;      // 内置成员名（role 模板名）
  alias:      string;      // 用户备注名；无备注时 = memberName
  scope:      RosterScope;
  status:     string;      // 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE' | ...
  address:    string;      // 'local:<instanceId>' | 'remote:...'
  teamId:     string | null;
  task:       string | null;
}

export type SearchResult =
  | { match: 'unique';   target: RosterEntry }
  | { match: 'multiple'; candidates: RosterEntry[] }
  | { match: 'none';     query: string };
```

字段说明：
- `instanceId`：实例 UUID，前端主键。
- `memberName`：角色模板名（如 `frontend-dev`），不可改。
- `alias`：用户给实例起的备注名；搜索时按 alias 模糊匹配；未设置则落回 `memberName`。
- `scope`：`local` 本机 / `remote` 远端桌面。
- `status`：生命周期状态，字符串（后端开放，前端按需枚举展示）。
- `address`：信封 `to.address` 用的地址，直接带进 `/api/messages/send`。
- `teamId`：当前所属团队，可为 `null`（独立存在）。
- `task`：当前任务简述，可为 `null`。

## GET /api/roster

列出全部 roster。

Query：
- `scope`：`team` | `local` | `remote`（可选）。
- `callerInstanceId`：当 `scope=team` 时**必填**（以它的 teamId 过滤）。

Response 200：`RosterEntry[]`

错误：
- 400：`scope=team` 但缺 `callerInstanceId`。

## GET /api/roster/search

按 query 匹配 alias / memberName。

Query：
- `q`：必填，搜索词。
- `scope`：可选，同上。
- `callerInstanceId`：`scope=team` 必填。

Response 200：`SearchResult`

错误：
- 400：缺 `q` / `scope=team` 缺 `callerInstanceId`。

## GET /api/roster/:instanceId

取单个实例。

Response 200：`RosterEntry`
错误：404 `instance '<id>' not in roster`。

## POST /api/roster

> **调用方**：后端内部 subscriber（实例创建时自动注入）。前端**一般不调**，列出仅供对账/调试。

新增实例（一般由后端自动创建，前端很少用）。

Body：
```json
{
  "instanceId": "...",
  "memberName": "frontend-dev",
  "scope":      "local",
  "status":     "PENDING",
  "address":    "local:<instanceId>",
  "alias":      "小前",
  "teamId":     null,
  "task":       null
}
```

必填：`instanceId`、`memberName`、`scope`、`status`、`address`。
`alias` 缺省 = `memberName`。

Response 201：`RosterEntry`
错误：400 缺字段 / 409 `instance '<id>' already exists`。

## PUT /api/roster/:instanceId

更新可变字段。

Body（全部可选，按需传）：
```json
{
  "status":  "ACTIVE",
  "address": "local:<id>",
  "teamId":  "<teamId> | null",
  "task":    "解释这段代码 | null"
}
```

Response 200：`RosterEntry`
错误：404 实例不存在。

## PUT /api/roster/:instanceId/alias

设备注名（最常用的交互）。

Body：
```json
{ "alias": "小前端" }
```

Response 200：
```json
{ "instanceId": "<id>", "alias": "小前端" }
```

错误：400 缺 `alias` / 404 实例不存在。

## DELETE /api/roster/:instanceId

删除实例。

Response 204 无 body。
错误：404 实例不存在。

## 错误码汇总

| Status | 场景                                                 |
|--------|------------------------------------------------------|
| 400    | 参数缺失 / 非法；`scope=team` 缺 `callerInstanceId` |
| 404    | `instanceId` 不在 roster                             |
| 409    | POST 时 `instanceId` 已存在                          |
