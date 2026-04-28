# 数字员工 API（WS）

> **面向**：前端员工面板 / 员工卡片 / 员工活跃度视图。**全部走 WebSocket**，不开放 HTTP 端点。

---

## 业务概念

"数字员工"是角色模板（`role_templates`）面向用户的展示层包装。它是前端用语，服务端没有独立的 `workers` 表。

- **一个员工 = 一个角色模板**（以 `templateName` 作为员工的身份锚点，如 `frontend-dev`）。
- **员工不是实例**：一个员工可能在多个团队里同时有多个实例（`role_instances`），但用户视角他就是"一个人"。
- **在线状态**：按该员工（= 该模板）名下实例的聚合结果决定
  - `online` — 至少 1 个实例处于 `ACTIVE`
  - `idle` — 有实例但没有一个是 `ACTIVE`（例：全部 `PENDING` / `PENDING_OFFLINE`）
  - `offline` — 该模板名下没有任何实例
- **最近工作**：从该模板所有实例的 `turn_history` 聚合（取时间最新的一条）。
- **所在团队**：从该模板所有实例的 `team_members` 关联反查 `teams`，去重后聚合。

### 底层表关系

```
role_templates（员工定义：name / role / description / persona / avatar / availableMcps）
  └── role_instances（实例，1:N；通过 templateName 关联）
        ├── team_members → teams（所在团队；一个实例最多一个团队）
        └── turn_history（工作记录；按 driverId = instance.id 聚合）
```

### 这份接口的边界

- **纯读**，只通过 WS 查询，不改任何数据。
- **不暴露 HTTP 端点**（`/api/panel/workers` 不存在；请勿调用）。
- 员工的增删改走模板通道（`/api/panel/templates/*`，见 [templates-and-mcp.md](./templates-and-mcp.md)），实例的启停走 `/api/panel/instances/*`（见 [instances-api.md](./instances-api.md)）。
- 员工的"在线/最近工作/所在团队"是实时从底层表聚合的投影，不依赖单独的缓存表。前端若要实时更新员工状态，订阅 `instance.*` / `team.*` / `turn.*` 事件后重新发起 `get_workers` 请求，或按需轮询。
- 本接口不推送 WS 事件，只响应前端主动请求（request/response 模式，和 `get_turns` / `get_turn_history` 一致）。

---

## WS 接口

### 上行 `get_workers` — 拉员工列表 + 统计

**上行**：

```json
{ "op": "get_workers", "requestId": "r-w-1" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | `'get_workers'` | 是 | 固定值 |
| `requestId` | `string` | 否 | 下行 `get_workers_response` 原样回填，用于前端对应请求 |

**下行 `get_workers_response`**：

```json
{
  "type": "get_workers_response",
  "requestId": "r-w-1",
  "workers": [
    {
      "name": "frontend-dev",
      "role": "前端开发专家",
      "description": "负责 React/TypeScript 组件开发、页面对接",
      "persona": "专业、务实、讲究细节",
      "avatar": "avatar-01",
      "mcps": ["mteam", "mnemo"],
      "status": "online",
      "instanceCount": 2,
      "teams": ["官网重构", "移动端适配"],
      "lastActivity": {
        "summary": "和 Leader 协作完成登录页样式",
        "at": "2026-04-27T10:32:15.420Z"
      }
    }
  ],
  "stats": { "total": 11, "online": 4, "idle": 2, "offline": 5 }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 回填上行 `requestId`（上行未传则回 `""`） |
| `workers[].name` | `string` | 员工身份锚点，= `role_templates.name` |
| `workers[].role` | `string` | 岗位名，= 模板的 `role` 字段 |
| `workers[].description` | `string \| null` | 岗位描述 |
| `workers[].persona` | `string \| null` | 人设 / tone |
| `workers[].avatar` | `string \| null` | 头像 id，对应 `/api/panel/avatars` 返回的条目 |
| `workers[].mcps` | `string[]` | 该员工可用的 MCP 名称（来自模板 `availableMcps[].name`） |
| `workers[].status` | `WorkerStatus` | `online` / `idle` / `offline`，详见上文"在线状态"规则 |
| `workers[].instanceCount` | `number` | 该员工当前存在的实例数量（含所有状态） |
| `workers[].teams` | `string[]` | 该员工实例关联的团队名列表，去重 |
| `workers[].lastActivity` | `{summary, at} \| null` | 最近一次 turn 摘要 + ISO 时间；无 turn_history 时为 `null` |
| `stats.total` | `number` | 员工总数 |
| `stats.online` / `idle` / `offline` | `number` | 按 status 分桶计数，三者之和 = total |

**错误**：上行 schema 非法（含额外字段等）→ 下行 `error { code: 'bad_request' }`。

---

### 上行 `get_worker_activity` — 拉员工活跃度

**上行**：

```json
{
  "op": "get_worker_activity",
  "range": "day",
  "workerName": "frontend-dev",
  "requestId": "r-wa-1"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | `'get_worker_activity'` | 是 | 固定值 |
| `range` | `ActivityRange` | 是 | `'minute' \| 'hour' \| 'day' \| 'month' \| 'year'` |
| `workerName` | `string` | 否 | 员工身份锚点（= 模板 `name`）。不传 = 全员聚合 |
| `requestId` | `string` | 否 | 下行 `get_worker_activity_response` 原样回填 |

**下行 `get_worker_activity_response`**：

```json
{
  "type": "get_worker_activity_response",
  "requestId": "r-wa-1",
  "range": "day",
  "workerName": "frontend-dev",
  "dataPoints": [
    { "label": "2026-04-25", "turns": 8, "toolCalls": 22 },
    { "label": "2026-04-26", "turns": 12, "toolCalls": 31 },
    { "label": "2026-04-27", "turns": 15, "toolCalls": 42 }
  ],
  "total": { "turns": 35, "toolCalls": 95 }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 回填上行 `requestId` |
| `range` | `ActivityRange` | 回显入参 |
| `workerName` | `string \| null` | 回显入参；上行不传时为 `null`（表示全员聚合） |
| `dataPoints[].label` | `string` | 时间桶展示标签（日 `YYYY-MM-DD` / 月 `YYYY-MM` / 年 `YYYY` / 小时 `YYYY-MM-DD HH:00` / 分 `YYYY-MM-DD HH:mm`） |
| `dataPoints[].turns` | `number` | 该时间桶内 turn 完成数 |
| `dataPoints[].toolCalls` | `number` | 该时间桶内 tool_call block 数量 |
| `total.turns` | `number` | 全部时间桶 turns 之和 |
| `total.toolCalls` | `number` | 全部时间桶 toolCalls 之和 |

**错误**：

- `range` 非枚举值 → 下行 `error { code: 'bad_request' }`
- `workerName` 不存在（= 没有这个模板）→ 下行 `error { code: 'not_found' }`

---

## TypeScript 契约

```ts
// ---- 上行 ----
export interface WsGetWorkers {
  op: 'get_workers';
  requestId?: string;
}

export type ActivityRange = 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface WsGetWorkerActivity {
  op: 'get_worker_activity';
  range: ActivityRange;
  workerName?: string;
  requestId?: string;
}

// ---- 下行 ----
export type WorkerStatus = 'online' | 'idle' | 'offline';

export interface WorkerView {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  avatar: string | null;
  mcps: string[];
  status: WorkerStatus;
  instanceCount: number;
  teams: string[];
  lastActivity: { summary: string; at: string } | null;
}

export interface WsGetWorkersResponse {
  type: 'get_workers_response';
  requestId: string;
  workers: WorkerView[];
  stats: {
    total: number;
    online: number;
    idle: number;
    offline: number;
  };
}

export interface ActivityDataPoint {
  label: string;
  turns: number;
  toolCalls: number;
}

export interface WsGetWorkerActivityResponse {
  type: 'get_worker_activity_response';
  requestId: string;
  range: ActivityRange;
  workerName: string | null;
  dataPoints: ActivityDataPoint[];
  total: { turns: number; toolCalls: number };
}
```

---

## 使用场景

| 场景 | 做法 |
|---|---|
| 员工大列表 | WS 发 `{op:'get_workers', requestId}` → 收 `get_workers_response` 渲染卡片；订 `instance.created/activated/deleted` + `team.member_joined/left` 重新发 `get_workers` 或本地重算 |
| 员工卡片右上角状态点 | 读 `workers[i].status` 直接映射 `online/idle/offline` 三色 |
| 点击员工卡片聊天按钮 | 用 `worker.name` 去 `/api/panel/instances` 找该模板下的 `ACTIVE` 实例，拿到 `teamId` → 前端跳 teamCanvas；若无 ACTIVE 实例，引导用户创建实例或进模板编辑 |
| 员工工作量图表 | WS 发 `{op:'get_worker_activity', range:'day', requestId}` 画近 N 天折线图；切粒度改 `range` |
| 单员工详情页活跃度 | WS 发 `{op:'get_worker_activity', range:'hour', workerName:'frontend-dev', requestId}` |

---

## 相关文档

- [ws-protocol.md](./ws-protocol.md) — WS 上下行契约总表
- [templates-and-mcp.md](./templates-and-mcp.md) — 模板 CRUD（员工定义的真正入口）
- [instances-api.md](./instances-api.md) — 实例 CRUD + 生命周期
- [teams-api.md](./teams-api.md) — 团队关联
- [turn-events.md](./turn-events.md) — `turn_history` 的来源
- [INDEX.md §1](./INDEX.md) — WS 上下行总表
