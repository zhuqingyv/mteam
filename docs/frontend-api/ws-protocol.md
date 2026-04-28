# WebSocket 协议

> **面向**：前端（WebSocket 客户端，浏览器 / Electron renderer）。Agent 进程**不连 WS**，所有本文协议字段（`subscribe` / `prompt` / `event` / `gap-replay` / …）都是前端专属。

## 连接

```
ws://localhost:58590/ws/events?userId=<string>
```

`userId` 必填，决定 `user` scope 订阅的身份，跨 user 的 `prompt` 会被拒。

## TypeScript 契约

```ts
export type SubscriptionScope = 'global' | 'team' | 'instance' | 'user';

export type WsErrorCode =
  | 'bad_request'    // JSON 解析失败 / schema 不合法 / 额外字段
  | 'not_found'      // 订阅目标 team/instance 不存在
  | 'forbidden'      // 越权订阅（user scope id !== ctx.userId）/ 跨 user prompt
  | 'not_ready'      // prompt 目标 driver 尚未 READY
  | 'internal_error';

// ---- 上行 ----
export interface WsSubscribe   { op: 'subscribe';   scope: SubscriptionScope; id?: string; lastMsgId?: string }
export interface WsUnsubscribe { op: 'unsubscribe'; scope: SubscriptionScope; id?: string }
export interface WsPrompt      { op: 'prompt';      instanceId: string; text: string; requestId?: string }
export interface WsPing        { op: 'ping' }
export interface WsCancelTurn  { op: 'cancel_turn'; instanceId: string; requestId?: string }
export interface WsConfigurePrimaryAgent {
  op: 'configure_primary_agent';
  cliType: string;            // 必填，非空
  name?: string;
  systemPrompt?: string;
  requestId?: string;
}
export interface WsGetTurns {
  op: 'get_turns';
  driverId: string;
  limit?: number;
  requestId?: string;
}
export interface WsGetTurnHistory {
  op: 'get_turn_history';
  driverId: string;
  limit?: number;
  beforeEndTs?: string;
  beforeTurnId?: string;
  requestId?: string;
}
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
export interface WsPermissionResponse {
  op: 'permission_response';
  requestId: string;    // 对应下行 permission_requested.requestId
  optionId: string;     // 从 permission_requested.options[].optionId 里选一个
}
export type WsUpstream =
  | WsSubscribe | WsUnsubscribe | WsPrompt | WsPing | WsCancelTurn | WsConfigurePrimaryAgent
  | WsGetTurns | WsGetTurnHistory | WsGetWorkers | WsGetWorkerActivity
  | WsPermissionResponse;

// ---- 下行 ----
export interface WsEventDown { type: 'event';      id: string; event: Record<string, unknown> }
export interface WsGapReplay { type: 'gap-replay'; items: Array<{ id: string; event: Record<string, unknown> }>; upTo: string | null }
export interface WsPong      { type: 'pong';       ts: string }
export interface WsAck       { type: 'ack';        requestId: string; ok: boolean; reason?: string }
export interface WsErrorDown { type: 'error';      code: WsErrorCode; message: string }
export interface WsSnapshot  { type: 'snapshot';   primaryAgent: PrimaryAgentRow | null }
export interface WsGetTurnsResponse {
  type: 'get_turns_response';
  requestId: string;
  active: Turn | null;
  recent: Turn[];
}
export interface WsGetTurnHistoryResponse {
  type: 'get_turn_history_response';
  requestId: string;
  items: Turn[];
  hasMore: boolean;
  nextCursor: { endTs: string; turnId: string } | null;
}
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
  stats: { total: number; online: number; idle: number; offline: number };
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
export interface WsPermissionRequested {
  type: 'permission_requested';
  instanceId: string;   // 触发权限请求的 driver（主 Agent 或成员）
  requestId: string;    // 前端回包必须原样带回
  toolCall: { name: string; title?: string; input?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}
export type WsDownstream =
  | WsEventDown | WsGapReplay | WsPong | WsAck | WsErrorDown | WsSnapshot
  | WsGetTurnsResponse | WsGetTurnHistoryResponse
  | WsGetWorkersResponse | WsGetWorkerActivityResponse
  | WsPermissionRequested;
```

## 上行消息

### subscribe

订阅事件流。`scope='global'` 时 `id` 可省略；其余必填。`lastMsgId` 用于断线重连补发。

```json
{ "op": "subscribe", "scope": "instance", "id": "inst_abc", "lastMsgId": "evt_123" }
```

### unsubscribe

```json
{ "op": "unsubscribe", "scope": "team", "id": "team_42" }
```

### prompt

**fire-and-forget** — 向指定实例投递用户消息。后端直接调用 `driver.prompt(text)`，**不经过 CommRouter / Envelope**，agent 收到用户原文。`ack` 只代表"接收到"，不代表"执行完"。真正的结果通过 `driver.*` 事件流推回（订阅 `instance` scope 即可）。

```json
{ "op": "prompt", "instanceId": "inst_abc", "text": "hello", "requestId": "req_1" }
```

### ping

心跳，建议每 30s 一次。

```json
{ "op": "ping" }
```

### cancel_turn — 停止 Agent 生成

**fire-and-forget** — 中断指定实例当前正在回复的 Turn。后端向 ACP agent 发 `session/cancel` notification，agent 会以 `stopReason='cancelled'` 提前结束当前 prompt，走正常的 `turn.completed` 事件路径。

```json
{ "op": "cancel_turn", "instanceId": "inst_abc", "requestId": "req_c1" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `instanceId` | string | 必填；成员用 `RoleInstance.id`，主 Agent 用 `PrimaryAgentRow.id` |
| `requestId` | string | 可选；原样回填到 `ack.requestId` |

- driver 不存在 → 下行 `error{code:'not_found'}`
- driver 不在 WORKING（READY/STOPPED）→ 仍回 `ack{ok:true}`（幂等，后端内部 noop）
- 成功 → 立即 `ack{ok:true}`；稍后后端 emit `turn.completed`（`stopReason='cancelled'`）推回前端

### configure_primary_agent

配置主 Agent。`cliType` 必填非空（后端合法值：`claude` / `codex`，未知值由后端拒并回 `internal_error`）。切换 `cliType` 时后端会先 `stop` 旧 driver 再以新配置 `start` 新 driver —— 全程通过 `primary_agent.*` 事件流推下来。

```json
{
  "op": "configure_primary_agent",
  "cliType": "codex",
  "name": "MTEAM",
  "systemPrompt": "you are helpful",
  "requestId": "req_9"
}
```

**时序保证**（fire-and-forget）：

1. 立即回 `ack{requestId, ok:true}` —— 不等 configure 内部 stop/start 跑完。
2. configure 完成后触发 `primary_agent.configured`（含完整 `row`）事件。
3. 若 `cliType` 变更 → 先 `primary_agent.stopped` → 新 driver 起来后 `primary_agent.started`。
4. configure/start 抛错（如 `cliType` 未知） → 下行 `error{code:'internal_error', message}`。

**本期能力边界**：WS configure 只支持 `cliType / name / systemPrompt`。`mcpConfig` 字段形状复杂且前端设置页目前不在 WS 流里改它，**本期不走 WS 暴露**，如需改 `mcpConfig` 仍走 HTTP `POST /api/primary-agent/config`。

额外字段（schema 外的键）一律拒，后端回 `bad_request`。

### get_turns — 拉 Turn 内存快照

上行：
```json
{ "op": "get_turns", "driverId": "inst_01", "limit": 10, "requestId": "r1" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `driverId` | string | 必填；总控用 `PrimaryAgentRow.id`，成员用 `RoleInstance.id` |
| `limit` | number | 可选，默认 10，上限 50；非法值回退默认 |
| `requestId` | string | 可选；下行 `get_turns_response` 原样回填 |

下行 `get_turns_response`：
```json
{
  "type": "get_turns_response",
  "requestId": "r1",
  "active": { "turnId": "turn_cur", "status": "active", "userInput": {...}, "blocks": [...], "startTs": "..." },
  "recent": [ { "turnId": "turn_prev", "status": "done", "stopReason": "end_turn", "blocks": [...], "endTs": "..." } ]
}
```

- driver 从未跑过 → `active: null`, `recent: []`（不报错）
- `recent` 按 `endTs` 降序（新在前），**不含** `active`
- 详见 [turn-events.md §4 快照查询](./turn-events.md)

### get_turn_history — 拉 Turn 持久化冷历史（keyset 翻页）

上行：
```json
{
  "op": "get_turn_history",
  "driverId": "inst_01",
  "limit": 10,
  "beforeEndTs": "2026-04-26T12:00:00Z",
  "beforeTurnId": "turn_abc",
  "requestId": "r2"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `driverId` | string | 必填 |
| `limit` | number | 可选，默认 10，上限 50；非法值回退默认 |
| `beforeEndTs` | string | 游标：上一页最后一条的 `endTs`（ISO） |
| `beforeTurnId` | string | 游标：上一页最后一条的 `turnId` |
| `requestId` | string | 可选；下行 `get_turn_history_response` 原样回填 |

- `beforeEndTs` 和 `beforeTurnId` **必须成对**，缺一方视为首页
- 排序：`end_ts DESC, turn_id DESC`（新在前）

下行 `get_turn_history_response`：
```json
{
  "type": "get_turn_history_response",
  "requestId": "r2",
  "items": [ { "turnId": "turn_abc", "driverId": "inst_01", "status": "done", "blocks": [...], "startTs": "...", "endTs": "..." } ],
  "hasMore": true,
  "nextCursor": { "endTs": "2026-04-26T12:00:00Z", "turnId": "turn_abc" }
}
```

- `hasMore: false` + `nextCursor: null` → 已到末尾
- `items` 为空数组 → 该 driver 无历史记录（不报错）
- 详见 [turn-events.md §8 冷历史接口](./turn-events.md)

### get_workers — 拉数字员工列表 + 统计

上行：
```json
{ "op": "get_workers", "requestId": "r-w-1" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | string | 可选；下行 `get_workers_response` 原样回填 |

下行 `get_workers_response`：
```json
{
  "type": "get_workers_response",
  "requestId": "r-w-1",
  "workers": [
    {
      "name": "frontend-dev",
      "role": "前端开发专家",
      "description": "…",
      "persona": "…",
      "avatar": "avatar-01",
      "mcps": ["mteam", "mnemo"],
      "status": "online",
      "instanceCount": 2,
      "teams": ["官网重构"],
      "lastActivity": { "summary": "…", "at": "2026-04-27T10:32:15.420Z" }
    }
  ],
  "stats": { "total": 11, "online": 4, "idle": 2, "offline": 5 }
}
```

- 纯读聚合，不依赖缓存表；不推 WS 事件，前端需重新发请求刷新
- 详见 [workers-api.md](./workers-api.md)

### get_worker_activity — 拉员工活跃度

上行：
```json
{
  "op": "get_worker_activity",
  "range": "day",
  "workerName": "frontend-dev",
  "requestId": "r-wa-1"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `range` | string | 必填；`'minute' \| 'hour' \| 'day' \| 'month' \| 'year'` |
| `workerName` | string | 可选；员工身份锚点（= 模板 `name`），不传 = 全员聚合 |
| `requestId` | string | 可选；下行 `get_worker_activity_response` 原样回填 |

下行 `get_worker_activity_response`：
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

- `range` 非枚举值 → 下行 `error { code: 'bad_request' }`
- `workerName` 不存在 → 下行 `error { code: 'not_found' }`
- 详见 [workers-api.md](./workers-api.md)

### permission_response — 用户对 ACP 权限请求的回应

**半自动模式专用。** 后端在半自动下通过下行 `permission_requested` 把 ACP `session/request_permission` 透传给前端，前端弹窗展示工具名/参数 + 选项按钮，用户点选后发这条上行消息把结果带回后端 → 后端以 `outcome: 'selected', optionId` resolve ACP 请求 → agent 继续执行。

```json
{ "op": "permission_response", "requestId": "perm_abc", "optionId": "allow" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | string | 必填；**原样**回填下行 `permission_requested.requestId` |
| `optionId` | string | 必填；从 `permission_requested.options[].optionId` 里选一个；不在列表里或字段缺失 → 后端按超时处理 |

**时序 / 错误处理**：

- 前端收到 `permission_requested` 起 **30s 超时窗**。超时不响应 → 后端自动按 `outcome: 'cancelled'` resolve，agent 以"用户取消"分支继续；之后再发 `permission_response` 后端按陈旧丢弃（无 ack）。
- 后端收到后不单独回 `ack`；是否生效可由 agent 的后续 `turn.block_updated` / `turn.completed` 路径间接观察。
- 全自动模式（`autoApprove=true` / `permissionMode='auto'`）下后端不会推 `permission_requested`，前端发这条上行也会被后端静默忽略。
- 可选 `optionId` 的 `kind` 取值示例：`allow_once` / `allow_always` / `reject_once` / `reject_always`（来自 ACP 协议，具体值由 agent 端给，前端**不要**硬编码白名单 —— 按 `permission_requested.options` 渲染按钮即可）。

## 下行消息

### event

单条 bus 事件。`id` 全局唯一（comm.* 场景 = messageId），可作为 `lastMsgId` 续传游标。`event.type` 即领域事件类型（详见 `bus-events.md`）。

```json
{
  "type": "event",
  "id": "evt_7f8",
  "event": { "type": "driver.text", "driverId": "drv_1", "content": "hi", "ts": "2026-04-25T10:00:00Z", "eventId": "evt_7f8" }
}
```

数字员工状态变化（`worker.status_changed`）也走这条通道下发，前端订阅 `global` scope 即可收到：

```json
{
  "type": "event",
  "id": "evt_abc123",
  "event": {
    "type": "worker.status_changed",
    "name": "frontend-dev",
    "status": "online",
    "instanceCount": 2,
    "teams": ["官网重构"],
    "ts": "2026-04-27T10:32:15.420Z",
    "eventId": "evt_abc123"
  }
}
```

详见 [workers-api §实时推送](./workers-api.md)。

### gap-replay

补发批次。`upTo=null` 表示无 gap；非 null 时 = 本批最新一条 id（正常）或最老一条 id（超量，前端拿它作为新的 `lastMsgId` 再次 `subscribe` 续拉）。

**次序保证**：`subscribe` 带 `lastMsgId` 后，`gap-replay` **先到**，之后的实时 `event` 才到；如果 prompt 的 `ack` 和 gap-replay 同时发生，也保证 gap-replay 在前。

```json
{
  "type": "gap-replay",
  "items": [
    { "id": "evt_124", "event": { "type": "driver.text", "content": "...", "ts": "..." } }
  ],
  "upTo": "evt_124"
}
```

### pong

```json
{ "type": "pong", "ts": "2026-04-25T10:00:00Z" }
```

### ack

多个上行 op 的确认回执：`prompt` / `subscribe` / `unsubscribe` / `configure_primary_agent`。`ok=false` 时 `reason` 带人类可读文案。

```json
{ "type": "ack", "requestId": "req_1", "ok": true }
{ "type": "ack", "requestId": "req_1", "ok": false, "reason": "driver not ready" }
```

### error

连接级错误。不带 `requestId` —— 上下文由 `message` 描述。

```json
{ "type": "error", "code": "forbidden", "message": "cannot subscribe user scope with foreign id" }
```

### snapshot

**每次 WS 连接建立时推一次，且一定在任何 `event` / `ack` 之前到达。** 载荷等价 `GET /api/primary-agent`；未配置时 `primaryAgent: null`。字段形状完整来自 `PrimaryAgentRow`（详见 `primary-agent-api.md` 的 types 小节）。

```json
{
  "type": "snapshot",
  "primaryAgent": {
    "id": "p1",
    "name": "MTEAM",
    "cliType": "claude",
    "systemPrompt": "",
    "mcpConfig": [],
    "status": "RUNNING",
    "agentState": "idle",
    "sandbox": true,
    "autoApprove": true,
    "createdAt": "2026-04-25T00:00:00.000Z",
    "updatedAt": "2026-04-25T00:00:00.000Z"
  }
}
```

未配置时：

```json
{ "type": "snapshot", "primaryAgent": null }
```

**status** 只会是 `'STOPPED' | 'RUNNING'` 两个值。**agentState** 为 `'idle' | 'thinking' | 'responding'`，反映总控当前工作状态（刷新页面时 snapshot 携带实时值）。driver 崩溃走服务端 self-heal；give_up 时 status 被置 `STOPPED`，前端按断线离线态渲染。

### permission_requested

**仅在半自动权限模式下下发。** ACP agent 发出 `session/request_permission` 时，后端透传给前端；前端弹权限确认窗，用户选完后发上行 `permission_response` 带回 `requestId + optionId`。

```json
{
  "type": "permission_requested",
  "instanceId": "inst_abc",
  "requestId": "perm_01",
  "toolCall": {
    "name": "Read",
    "title": "Read file",
    "input": { "path": "/tmp/x.txt" }
  },
  "options": [
    { "optionId": "allow",        "name": "Allow once",   "kind": "allow_once"   },
    { "optionId": "allow_always", "name": "Allow always", "kind": "allow_always" },
    { "optionId": "reject",       "name": "Reject",       "kind": "reject_once"  }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `instanceId` | string | 触发该权限请求的 driver id；主 Agent 用 `PrimaryAgentRow.id`，成员用 `RoleInstance.id`。前端据此把弹窗定位到正确的会话窗口 |
| `requestId` | string | 权限请求唯一 id；上行 `permission_response.requestId` **必须原样回填** |
| `toolCall.name` | string | ACP 工具名（如 `Read` / `Write` / `Bash`） |
| `toolCall.title` | string? | 工具的人类可读标题，缺省时前端退回到 `name` |
| `toolCall.input` | unknown? | 工具参数对象（由 agent 给出，形状随工具而变）；前端原样展示，不做 schema 校验 |
| `options` | Array | 可选项列表，至少 1 条 |
| `options[].optionId` | string | 选项 id，上行 `permission_response.optionId` 填这个 |
| `options[].name` | string | 按钮文案（ACP agent 端给的人类可读标签） |
| `options[].kind` | string | ACP 约定的选项类别；常见 `allow_once` / `allow_always` / `reject_once` / `reject_always`，**前端按 `options` 原样渲染**，不要硬编码仅识别某些 kind |

**时序 / 边界**：

- **30s 超时**：前端必须在 30 秒内发 `permission_response`；超时后端自动按 `outcome: 'cancelled'` resolve ACP，agent 以"用户取消"分支继续。前端超时后再回也不会生效。
- 全自动模式（`autoApprove=true` 或 `permissionMode='auto'`）下**不会**下发此消息，前端无需关心。
- 未订阅 `instance` scope 时也会下发（权限请求不经订阅过滤，按连接级投递；未来可能收窄，前端不要依赖"订了才收到"）。
- `permission_requested` **不走** `event` 通道，不是 bus 事件，没有 `id` 字段，不参与 `lastMsgId` 的 gap-replay 恢复。断线期间错过的权限请求会在后端 30s 超时后被 `cancelled`，不补推。

## 错误码表

| code            | 触发场景                                                    |
| --------------- | ----------------------------------------------------------- |
| `bad_request`   | 非合法 JSON / schema 不匹配 / 有额外字段 / 缺必填字段       |
| `not_found`     | `subscribe` 的 team/instance 在服务端不存在                 |
| `forbidden`     | 订 `user` scope 但 `id !== ctx.userId` / `prompt` 跨 user   |
| `not_ready`     | `prompt` 时目标 driver 还未进入 READY 态（会走 ack.ok=false） |
| `internal_error`| 广播/序列化意外失败                                         |

## User scope 限制

`scope='user'` 的订阅，`id` 必须等于连接时的 `userId`；否则直接 `forbidden`。只能订自己。`prompt` 同理 —— 目标 instance 的归属 user 必须匹配当前连接，否则 `forbidden`。
