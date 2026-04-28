# ActionItem API

> **面向**：前端 UI（待办面板 / 审批弹窗 / 决策请求入口）。ActionItem 是 Phase 4 新增的"待办"领域，用于替代消息里混杂的"你帮我做个 X"语义，让 task / approval / decision / authorization 四类人机协作请求有独立的生命周期、deadline 与解决语义。
>
> **前端调用前缀**：一律走 `/api/panel/action-items/*` 门面层，不直接调底层 `/api/action-items/*`。
>
> **相关实时事件**：订阅 `global` 或 `user:<userId>` scope，消费 `action_item.created / updated / reminder / resolved / timeout`。WS 投递维度：created/updated/resolved/timeout 按 creator/assignee/teamId 三维路由；reminder 仅投递给 assignee。

全部返回 JSON。成功 2xx，错误 4xx/5xx + `{ error: string }`。

---

## TS 类型

```ts
type ActionItemKind = 'task' | 'approval' | 'decision' | 'authorization';

type ActionItemStatus =
  | 'pending'       // 已创建、待认领/处理
  | 'in_progress'   // 处理中（目前 HTTP 层不自动进入，由 agent 侧 claim 流转，暂未落地）
  | 'done'          // 处理完成（resolve: done）
  | 'rejected'      // 拒绝（resolve: rejected）
  | 'timeout'       // 超时（scheduler 自动置位）
  | 'cancelled';    // 创建方取消（PUT cancel）

// 比 comm envelope 的 ActorRef 更窄：action-item 只关心 kind + id
interface ActorId {
  kind: 'user' | 'agent' | 'system';
  id: string;
}

interface ActionItem {
  id: string;                    // UUID v4（服务端生成）
  kind: ActionItemKind;
  title: string;                 // 1~200 字符
  description: string;           // 可为空字符串
  creator: ActorId;              // 发起方
  assignee: ActorId;             // 受理方
  deadline: number;              // ms 时间戳（必须 > Date.now() + 1000）
  status: ActionItemStatus;
  createdAt: number;             // ms
  updatedAt: number;             // ms（resolve / cancel / timeout 都会更新；reminder 不更新）
  remindedAt: number | null;     // 首次提醒时间；被提醒前为 null
  resolution: string | null;     // 当前实现未写入，reserved
  teamId: string | null;         // 关联 team（可选）
  relatedMessageId: string | null; // 关联消息 envelope id（可选）
}
```

### 四种 kind 的语义

| kind | 典型用途 | 前端 UI 建议 |
|---|---|---|
| `task`          | 普通待办、委派任务                          | 列表 + 完成按钮 |
| `approval`      | 需要批准的请求（上线/预算/权限）            | 弹窗 / Banner + 同意/拒绝 |
| `decision`      | 需要人做判断（A 还是 B）                    | 选项卡 + 提交 |
| `authorization` | 高权限动作的授权（执行危险命令、访问敏感）  | 强提示 + 倒计时 |

四类 kind 在后端 status 机上无区别，前端按 kind 自行决定展示样式。

---

## HTTP 端点

### 1. `POST /api/panel/action-items` — 创建待办

Request:
```json
{
  "kind": "approval",
  "title": "请批准 v2.3.0 上线",
  "description": "已过 QA，需要 RD lead 批准",
  "creatorKind": "agent",
  "creatorId": "leader-alice",
  "assigneeKind": "user",
  "assigneeId": "local",
  "deadline": 1745750000000,
  "relatedMessageUuid": "msg-uuid-xxx"
}
```

**字段规则**：
- `kind` 必填，枚举 `task` / `approval` / `decision` / `authorization`
- `title` 必填，1~200 字符
- `description` 可选，默认 `""`
- `creatorKind` / `creatorId` 必填；`creatorKind` ∈ `user` / `agent` / `system`
- `assigneeKind` / `assigneeId` 必填；同上
- `deadline` 必填，ms 时间戳，**必须 > `Date.now() + 1000`**（避免刚创建就超时）
- `relatedMessageUuid` 可选，关联消息的 envelope id；落库后在响应里映射为 `relatedMessageId`

> **扁平 vs 嵌套**：请求体是扁平的 `creatorKind / creatorId / assigneeKind / assigneeId`；响应体是嵌套的 `creator: { kind, id }` / `assignee: { kind, id }`。不要把请求体写成嵌套形式，会被校验拒绝。

Response `201`:
```json
{
  "id": "5e2c3f90-...-uuid",
  "kind": "approval",
  "title": "请批准 v2.3.0 上线",
  "description": "已过 QA，需要 RD lead 批准",
  "creator": { "kind": "agent", "id": "leader-alice" },
  "assignee": { "kind": "user",  "id": "local" },
  "deadline": 1745750000000,
  "status": "pending",
  "createdAt": 1745749000000,
  "updatedAt": 1745749000000,
  "remindedAt": null,
  "resolution": null,
  "teamId": null,
  "relatedMessageId": "msg-uuid-xxx"
}
```

同步 emit `action_item.created` bus 事件（WS 下发 `event` 消息）。

错误：
- `400 body must be an object`
- `400 kind must be task/approval/decision/authorization`
- `400 title must be 1~200 chars`
- `400 description must be string`（传了但不是字符串）
- `400 assigneeKind must be user/agent/system` / `assigneeId is required`
- `400 creatorKind must be user/agent/system` / `creatorId is required`
- `400 deadline must be number`
- `400 deadline must be > now + 1000ms`
- `400 relatedMessageUuid must be string`（传了但不是字符串）

---

### 2. `GET /api/panel/action-items` — 列表

Query：
- `assigneeId`（可选）— 列某受理方的所有待办
- `creatorId`（可选）— 列某发起方的所有待办
- `status`（可选）— 过滤状态，枚举同 `ActionItemStatus`

**过滤优先级**：`assigneeId` > `creatorId` > 无。同时传 `assigneeId` 和 `creatorId` 时只按 `assigneeId` 过滤。

**无过滤时**：返回**未完结**项（`status IN (pending, in_progress)`），按 `deadline ASC`；即使传了 `status=done` 无 assignee/creator，也只在未完结项里筛（当前实现限制）。前端要列"某人所有已完成"，必须同时带 `assigneeId` + `status=done`。

Response `200`:
```json
{
  "items": [
    { /* ActionItem */ },
    { /* ActionItem */ }
  ]
}
```

排序：`deadline ASC`（最急的在前）。

示例：
```
GET /api/panel/action-items                                    // 全量未完结
GET /api/panel/action-items?assigneeId=local                   // local 的所有待办
GET /api/panel/action-items?assigneeId=local&status=pending    // local 仅 pending
GET /api/panel/action-items?creatorId=leader-alice&status=done // alice 发起的已完成
```

---

### 3. `GET /api/panel/action-items/:id` — 查单个

Response `200`:
```json
{ /* ActionItem */ }
```

错误：
- `404`（id 不存在）

---

### 4. `PUT /api/panel/action-items/:id/resolve` — 解决待办

Request:
```json
{ "status": "done" }
```
或
```json
{ "status": "rejected" }
```

**规则**：`status` 只接受 `done` / `rejected`（取消走独立 `cancel` 端点）。

Response `200`:
```json
{ /* 更新后的 ActionItem，status 置为 done/rejected，updatedAt 刷新 */ }
```

同步 emit `action_item.resolved`（`outcome: 'done' | 'rejected'`）。

错误：
- `400 body must be an object`
- `400 status must be done or rejected`
- `404`（id 不存在）

> **幂等性提示**：当前实现不检查现有 status，即便项已经是 `done` / `rejected` / `timeout` / `cancelled`，也会被覆盖并 emit 新 `action_item.resolved`。前端对已完结项不应提供 resolve 按钮。

---

### 5. `PUT /api/panel/action-items/:id/cancel` — 取消待办

无 body。

Response `200`:
```json
{ /* 更新后的 ActionItem，status 置为 cancelled，updatedAt 刷新 */ }
```

同步 emit `action_item.resolved`（`outcome: 'cancelled'`）。

错误：
- `404`（id 不存在）

> 取消语义：创建方主动放弃（而不是受理方拒绝）。前端应按调用者身份决定按钮显隐：受理方看到「完成 / 拒绝」，创建方看到「取消」。

---

## WS 事件

订阅 `global` 或 `user:<userId>` scope 可收到。完整字段见 [bus-events.md §action_item](./bus-events.md)。

### `action_item.created`

新建待办时触发（POST 端点和服务端内部创建都会 emit）。

Payload（外层 `event.event`）：
```ts
{
  type: 'action_item.created',
  item: ActionItem,    // 完整对象
}
```

前端处理：按 `item.assignee.id === self.userId` 判断「我收到的」vs「我发出的」，分别进"收件"和"发件"面板。

### `action_item.updated`

待办字段变更（非 resolve/timeout 的状态流转，例如 scheduler 写 `remindedAt`）。

Payload：
```ts
{
  type: 'action_item.updated',
  item: ActionItem,
  changed: Array<'status' | 'title' | 'description' | 'deadline' | 'remindedAt' | 'resolution'>,
}
```

前端处理：按 `item.id` 增量更新本地缓存，只重绘 `changed` 里列出的字段即可。

> **注意**：当前 HTTP 路由不 emit `updated`（resolve/cancel 走 `resolved`）。`updated` 主要由后端 scheduler / subscriber 在非终态场景下发出。

### `action_item.reminder`

Deadline 临近、但尚未超时时，scheduler 会主动推提醒（默认剩余时间 ≤ 总时长的某个阈值且 `remindedAt IS NULL`）。

Payload：
```ts
{
  type: 'action_item.reminder',
  itemId: string,
  assignee: ActorId,
  remainingMs: number,   // 距离 deadline 的剩余毫秒数
}
```

**WS 投递维度**：仅投递给 `assignee`（不投 creator / team）。前端 assignee 收到就弹"即将到期"提示。

> Payload 只带 `itemId`，不带完整 item。前端若需要详情，按 id 查本地缓存或 `GET /api/panel/action-items/:id`。

### `action_item.resolved`

resolve（done/rejected）或 cancel 时触发。

Payload：
```ts
{
  type: 'action_item.resolved',
  item: ActionItem,
  outcome: 'done' | 'rejected' | 'cancelled',
}
```

前端处理：从"待办"面板移除、入"已完成"面板；`outcome=cancelled` 区别样式。

### `action_item.timeout`

Scheduler 检测到 `deadline < now` 且 status 仍在 `pending` / `in_progress` 时，自动置 `status=timeout` 并 emit。

Payload：
```ts
{
  type: 'action_item.timeout',
  item: ActionItem,
}
```

前端处理：红色告警入"超时"面板，提示 creator「对方未及时处理」。

---

## 典型场景

### 场景 1：Agent 发起审批，用户批准

1. Agent（如 leader）调用 MCP 工具 `send_to_agent { kind:'approval', ... }`（见 mteam-primary），后端服务端分支会 `createItem` + emit `action_item.created`。
2. 前端收 `action_item.created`（通过 `user:local` scope），弹审批卡片。
3. 用户点「批准」→ `PUT /api/panel/action-items/:id/resolve { status: 'done' }`。
4. 后端 emit `action_item.resolved { outcome:'done' }`，前端和 agent 都收到。

### 场景 2：用户派发任务给 Agent

1. 前端 `POST /api/panel/action-items { kind:'task', assigneeKind:'agent', assigneeId:'leader-alice', ... }`。
2. Agent 侧收到（通过 comm / primary agent inject），处理完后调服务端 MCP 工具标记完成，后端 `updateStatus → emit action_item.resolved`。
3. 前端收 `action_item.resolved`，任务从待办移除。

### 场景 3：临期提醒

1. 创建一条 `deadline = now + 10min` 的 task。
2. scheduler 在剩余比例 ≤ 阈值（如 20%）时 emit `action_item.reminder`。
3. 前端仅 assignee 收到，弹「还剩 2 分钟到期」提示。
4. 若 deadline 到了仍未 resolve，scheduler emit `action_item.timeout`。

---

## 错误码汇总

| Status | 场景 |
|---|---|
| 400    | 请求体/字段不合法（见各端点错误清单）|
| 404    | id 不存在                           |

> 当前实现未对"已完结项再次 resolve / cancel"做 409 拦截；前端需在 UI 层避免向已完结项发操作。

---

## 设计参考

- 后端类型：`packages/backend/src/action-item/types.ts`
- HTTP 路由：`packages/backend/src/http/routes/action-items.routes.ts`
- Bus 事件：`packages/backend/src/bus/types.ts` §action_item
- 设计文档：`docs/phase4/design.md` / `docs/phase4/INTERFACE-CONTRACTS.md`
