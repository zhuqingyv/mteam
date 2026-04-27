# Phase 4 · INTERFACE-CONTRACTS

> 冻结于 2026-04-27。本文件是 Phase 4 内所有模块共享的唯一权威接口。
> 设计文档（design.md）与 TASK-LIST.md 引用本文件；如有偏离以本文件为准。
> 变更流程：改动必须带 PR 说明 + 更新所有引用点；不得单方面修改。

---

## C-1 · GlobalTicker

### C-1.1 TypeScript 接口

```ts
// src/ticker/types.ts
export type TickerTaskId = string;

export interface TickerTask {
  /** 任务唯一 id。同 id 重复 schedule 视为 reschedule。 */
  id: TickerTaskId;
  /** 绝对触发时间（ms since epoch）。过去的值会在下一次 tick 立即触发。 */
  fireAt: number;
  /** 触发回调。抛错被 Ticker 内部 catch 并写 stderr，不影响其他任务。 */
  onFire: () => void | Promise<void>;
  /** 可选 tag，纯标签，用于调试/指标。 */
  tag?: string;
}

export interface GlobalTicker {
  /**
   * 注册或重注册一个一次性任务。
   * - 同 id 已存在：覆盖 fireAt / onFire / tag（等价于 reschedule）。
   * - fireAt 已过：下一次 tick 立即触发。
   * 不返回 Promise；注册本身是同步、即时的。
   */
  schedule(task: TickerTask): void;

  /**
   * 取消任务。未注册的 id 静默忽略（不抛）。
   */
  cancel(id: TickerTaskId): void;

  /**
   * 查询任务是否存在（未触发且未取消）。
   */
  has(id: TickerTaskId): boolean;

  /**
   * 启动 Ticker。幂等：多次调用只生效一次。
   */
  start(): void;

  /**
   * 停止 Ticker 并清空所有待触发任务。用于进程退出 / 测试 teardown。
   */
  stop(): void;

  /**
   * 当前任务数（含所有状态）。仅用于观测 / 测试断言。
   */
  size(): number;
}
```

### C-1.2 语义要点（实现方必须遵守）

1. **绝对时间戳判定**：每次醒来读 `Date.now()`，条件是 `now >= task.fireAt`。
   不累加 interval，不信 `setTimeout` 延迟，不用"下次应触发时间 = 上次 + interval"。
2. **自适应休眠**：每次触发完后，取剩余任务中最小 `fireAt - now` 作为下次
   `setTimeout` 延迟。没有任务时不设 timer（零空转）。
3. **批量触发**：一次 tick 内，把所有 `fireAt <= now` 的任务都触发完再休眠。
   event loop 被阻塞晚醒的积压任务会被一口气清掉。
4. **回调异常隔离**：任一 task 的 `onFire` 抛错 / Promise reject，
   Ticker 内部 catch 并写 `stderr`，其他 task 继续触发。
5. **unref**：Ticker 内部的 `setTimeout` 必须 `unref()`，不阻塞进程退出。
6. **线程安全约束**：Node.js 单线程，不需要锁；但回调内重入 `schedule/cancel`
   必须安全（实现通过 "本轮 tick 读当前快照，新增的任务进下一轮" 解决）。
7. **时钟回拨容忍**：不特殊处理。回调的 `fireAt` 是绝对值，系统时间回拨只会
   导致任务延后触发，不会错误触发。

### C-1.3 单例导出

```ts
// src/ticker/ticker.ts
export const ticker: GlobalTicker = new GlobalTickerImpl();
```

所有调用方统一从 `'../ticker/ticker.js'` 导入 `ticker`。
测试场景可自建 `new GlobalTickerImpl()` 实例注入。

---

## C-2 · ActionItem 数据模型

### C-2.1 TS 类型

```ts
// src/action-item/types.ts
export type ActionItemKind = 'task' | 'approval' | 'decision' | 'authorization';

export type ActionItemStatus =
  | 'pending'       // 新建，未处理
  | 'in_progress'   // assignee 已认领 / 正在处理
  | 'done'          // 成功完成
  | 'rejected'      // 被 assignee 主动拒绝
  | 'timeout'       // 超过 deadline 未完成
  | 'cancelled';    // creator 主动撤回

/** Actor 引用。与 comm/envelope.ts ActorRef 对齐但更窄：action-item 只需 kind+id。 */
export interface ActorId {
  kind: 'user' | 'agent' | 'system';
  /** user: userId；agent: instanceId；system: 固定 'system'。 */
  id: string;
}

export interface ActionItem {
  /** UUID v4。 */
  id: string;
  kind: ActionItemKind;
  title: string;                 // ≤ 200 字符
  description: string;           // 可空字符串，≤ 4000 字符
  creator: ActorId;
  assignee: ActorId;
  /** 绝对时间戳（ms since epoch），必填，创建后不可小于 now + 1000ms。 */
  deadline: number;
  status: ActionItemStatus;
  /** 创建时间（ms since epoch）。 */
  createdAt: number;
  /** 最近一次状态变更时间。 */
  updatedAt: number;
  /** 是否已发过"剩余≤10%"提醒；避免重复推送。 */
  remindedAt: number | null;
  /** 解决结果：done 时写结论文本；rejected 时写拒绝原因。其他状态为 null。 */
  resolution: string | null;
  /** 可选：关联的团队 / 来源消息 envelope uuid。 */
  teamId: string | null;
  relatedMessageId: string | null;
}
```

### C-2.2 SQLite Schema（`src/db/schemas/action_items.sql`）

```sql
-- ============================================================
-- action_items —— 统一待办/审批/决策/授权
-- 不改 messages 表；与 messages 通过 related_message_uuid 软关联。
-- ============================================================
CREATE TABLE IF NOT EXISTS action_items (
  id                    TEXT PRIMARY KEY,                -- UUID v4
  kind                  TEXT NOT NULL CHECK(kind IN ('task','approval','decision','authorization')),
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',

  creator_kind          TEXT NOT NULL CHECK(creator_kind IN ('user','agent','system')),
  creator_id            TEXT NOT NULL,
  assignee_kind         TEXT NOT NULL CHECK(assignee_kind IN ('user','agent','system')),
  assignee_id           TEXT NOT NULL,

  deadline              INTEGER NOT NULL,                -- ms epoch
  status                TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','rejected','timeout','cancelled'))
                                    DEFAULT 'pending',

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  reminded_at           INTEGER,                         -- null 表示未提醒过

  resolution            TEXT,

  team_id               TEXT,
  related_message_uuid  TEXT                             -- 软关联 messages.envelope_uuid
);

-- 列表/统计：按 assignee 拉未完成项
CREATE INDEX IF NOT EXISTS idx_action_items_assignee_status
  ON action_items(assignee_kind, assignee_id, status);

-- 创建者视角：查"我发出的待办"
CREATE INDEX IF NOT EXISTS idx_action_items_creator_status
  ON action_items(creator_kind, creator_id, status);

-- 调度扫描：找下一个 deadline 未超时的
CREATE INDEX IF NOT EXISTS idx_action_items_status_deadline
  ON action_items(status, deadline);
```

### C-2.3 Repo 接口

```ts
// src/action-item/repo.ts
export interface ActionItemRepo {
  create(input: Omit<ActionItem, 'id' | 'createdAt' | 'updatedAt' | 'remindedAt' | 'resolution' | 'status'>
          & Partial<Pick<ActionItem, 'id'>>): ActionItem;
  findById(id: string): ActionItem | null;

  /** 更新可变字段；返回最新行。id 不存在抛错。 */
  update(id: string, patch: Partial<Pick<ActionItem,
    'status' | 'resolution' | 'remindedAt' | 'updatedAt' | 'deadline' | 'title' | 'description'
  >>): ActionItem;

  /** 列表：按 assignee + status 过滤。 */
  listByAssignee(assignee: ActorId, opts?: { status?: ActionItemStatus; limit?: number }): ActionItem[];

  /** 列表：按 creator + status 过滤。 */
  listByCreator(creator: ActorId, opts?: { status?: ActionItemStatus; limit?: number }): ActionItem[];

  /** 找当前最早到期的 pending/in_progress 项（用于 Ticker 调度）。 */
  findNextDeadline(): ActionItem | null;

  /** 找所有 pending/in_progress 且 deadline <= now 的项（Ticker 批量扫描）。 */
  findOverdue(now: number): ActionItem[];

  /** 找所有 pending/in_progress 且 remindedAt IS NULL 且
   *  deadline - now <= (deadline - createdAt) * 0.1 的项（提醒扫描）。 */
  findDueForReminder(now: number): ActionItem[];
}

export function createActionItemRepo(): ActionItemRepo;
```

---

## C-3 · HTTP 接口（`/api/panel/action-items`）

所有接口走 `/api/panel/*` 前缀，返回 `ApiResponse` 契约（status + body）。
前端 ONLY 通过此前缀访问，不得直连底层。

### C-3.1 POST `/api/panel/action-items`

创建 ActionItem。

Request body:
```json
{
  "kind": "task",
  "title": "审查 PR #123",
  "description": "...",
  "assignee": { "kind": "agent", "id": "inst-uuid" },
  "deadline": 1745769600000,
  "teamId": "team-uuid",
  "relatedMessageId": "msg-uuid"
}
```
- `creator` 由服务端根据会话注入（HTTP 路径固定为 `{kind:'user', id:'local'}`；
  MCP 路径由工具入口注入 agent instanceId）。
- `deadline`：绝对 ms epoch，必须 `> Date.now() + 1000`。
- `description / teamId / relatedMessageId` 可选。

Response:
```json
{ "status": 201, "body": { "item": ActionItem } }
```

错误：400（字段校验） / 404（assignee 不存在）。

### C-3.2 GET `/api/panel/action-items`

列表。Query:
- `assignee=<kind>:<id>` 或 `creator=<kind>:<id>`，二选一（必填其一）。
- `status=pending,in_progress`（逗号分隔，可选；默认全部）。
- `limit=50`（默认 50，上限 200）。

Response: `{ status: 200, body: { items: ActionItem[] } }`

### C-3.3 POST `/api/panel/action-items/:id/resolve`

标记完成或拒绝。Body:
```json
{ "outcome": "done" | "rejected", "resolution": "..." }
```
- 只有状态 `pending` / `in_progress` 可转换；否则 409。
- `resolution` 在 `rejected` 时必填。

Response: `{ status: 200, body: { item: ActionItem } }`

### C-3.4 POST `/api/panel/action-items/:id/claim`

assignee 将 `pending` 转为 `in_progress`。

Response: `{ status: 200, body: { item: ActionItem } }`
- 非 assignee 调用：403。
- 状态非 `pending`：409。

### C-3.5 DELETE `/api/panel/action-items/:id`

creator 撤回（`cancelled`）。

Response: `{ status: 200, body: { item: ActionItem } }`
- 非 creator 调用：403。
- 状态已终止（done/rejected/timeout/cancelled）：409。

---

## C-4 · WS 事件

注册到 `WS_EVENT_TYPES`（白名单），通过现有 `ws-broadcaster` 分发。

### C-4.1 新增 `BusEventType`

```ts
| 'action_item.created'
| 'action_item.updated'
| 'action_item.reminder'
| 'action_item.resolved'
| 'action_item.timeout'
```

### C-4.2 Payload

```ts
export interface ActionItemCreatedEvent extends BusEventBase {
  type: 'action_item.created';
  item: ActionItem;
}

export interface ActionItemUpdatedEvent extends BusEventBase {
  type: 'action_item.updated';
  item: ActionItem;
  /** 触发字段，便于前端只更新关心的字段。 */
  changed: Array<'status' | 'title' | 'description' | 'deadline' | 'remindedAt' | 'resolution'>;
}

export interface ActionItemReminderEvent extends BusEventBase {
  type: 'action_item.reminder';
  itemId: string;
  assignee: ActorId;
  remainingMs: number;   // 剩余时间（ms）
}

export interface ActionItemResolvedEvent extends BusEventBase {
  type: 'action_item.resolved';
  item: ActionItem;
  outcome: 'done' | 'rejected' | 'cancelled';
}

export interface ActionItemTimeoutEvent extends BusEventBase {
  type: 'action_item.timeout';
  item: ActionItem;
}
```

所有事件 source 固定为 `'action-item'`。`ws-broadcaster` 按现有订阅过滤逻辑
（scope=global / team / instance / user）分发：
- `created / updated / resolved / timeout`：分发给 creator + assignee + teamId 三个维度。
- `reminder`：仅分发给 assignee。

### C-4.3 WS 上行订阅

沿用现有协议，不新增 op；前端订阅 `action_item.*` 通过已有 scope 机制。

---

## C-5 · send_to_agent 扩展

扩展 `src/mcp-primary/tools/send_to_agent.ts` 和 `src/mcp/tools/send_msg.ts`
的 kind + deadline 字段。

### C-5.1 新 schema（二者一致）

```ts
kind: { type: 'string', enum: ['chat', 'task', 'approval', 'decision', 'authorization'] }
deadline: { type: 'number', description: 'Absolute ms epoch. Required when kind != chat. Must be > now + 1000.' }
```

### C-5.2 运行时行为

- `kind='chat'`：行为与旧版完全一致，不创建 ActionItem。
- `kind ∈ {task, approval, decision, authorization}`：
  1. 校验 `deadline` 必填且 `> Date.now() + 1000`。
  2. 先走 `comm.send` 正常投递（保留消息通路）。
  3. 投递成功后同步创建 ActionItem：
     - `creator = from`（调用者身份），`assignee = 解析后的 to`。
     - `kind = args.kind`，`deadline = args.deadline`。
     - `title = summary`，`description = content`。
     - `relatedMessageId = envelope.id`（刚投递消息的 uuid）。
     - `teamId` 从 from/to 的 team 信息推断（见 design §5.3）。
  4. 返回值扩展：`{ delivered: true, to, actionItemId: <uuid> }`。

### C-5.3 兼容策略

- 旧调用（无 kind / kind=chat / 无 deadline）：行为不变，只校验现有字段。
- `kind != chat` 但 `deadline` 缺失：返回 `{ error: 'deadline is required when kind is task/approval/decision/authorization' }`，不投递消息。
- 旧表 `messages.kind` 校验放宽：`message-store` 的 `MessageKind` 类型在
  Phase 4 也追加新的 4 种值。DB 列无 CHECK 约束，migration 幂等。

---

## C-6 · ActionItemScheduler

### C-6.1 接口

```ts
// src/action-item/scheduler.ts
export interface ActionItemScheduler {
  /** 启动：从 repo 加载所有 pending/in_progress 项，为每个 deadline 向 Ticker 注册。 */
  start(): void;
  /** 停止：从 Ticker 撤销所有 action_item:* 任务。 */
  stop(): void;
  /** 任一 item 的 CRUD 事件都调用此方法，重新计算并注册到 Ticker。 */
  rescheduleOne(id: string): void;
  /** 取消某 item 的调度（resolve/cancel 后调用）。 */
  cancelOne(id: string): void;
}

export function createActionItemScheduler(opts: {
  repo: ActionItemRepo;
  ticker: GlobalTicker;
  bus: EventBus;
}): ActionItemScheduler;
```

### C-6.2 Ticker task id 命名

- `action_item:reminder:<itemId>`：剩余 ≤10% 提醒。
- `action_item:timeout:<itemId>`：deadline 到期。

每个 item 注册 ≤2 个 task；同 itemId 重注册自动覆盖（见 C-1.1 语义）。

### C-6.3 触发动作

- reminder: emit `action_item.reminder` + 通过 CommRouter 发一条 `system→assignee` 的
  summary="你的待办还剩 X 分钟" 消息（kind=chat，不再建 ActionItem，避免递归）。
- timeout: 事务内 `update(status='timeout')` + emit `action_item.timeout` +
  通过 CommRouter 发一条 `system→creator` 的通知。

### C-6.4 启动期并发

`start()` 从 repo.load all pending → 对每个 item 算 reminderAt / timeoutAt →
用 `ticker.schedule` 注册。过去 deadline 的直接触发 timeout 路径。
全程同步完成，不 emit 乱序事件。

---

## C-7 · 现有 setInterval 收编

### C-7.1 CliManager（`src/cli-scanner/manager.ts`）

- 删除 `this.timer = setInterval(...)` + `clearInterval`。
- `boot()` 首次 scanAndDiff 后，向 ticker 注册 `cli_scanner:poll`，fireAt = now + 30_000。
- scanAndDiff 结束时在 onFire 内部 reschedule 自身（fireAt = now + 30_000），形成"链式单发"。
- `teardown()` 调用 `ticker.cancel('cli_scanner:poll')`。

### C-7.2 ParentWatcher（`src/process-manager/parent-watcher.ts`）

- 把 `setInterval(fn, 500)` 改为 "ticker + 链式单发"。
- task id = `process:parent_watch`。
- 注意：ParentWatcher 是纯函数模块；改写后依然不 import 业务，通过
  `opts.ticker` 参数注入（默认 `ticker` 单例）。
- `stop()` 调用 `ticker.cancel('process:parent_watch')`。

### C-7.3 MemoryManager（`src/memory-manager/manager.ts`）

- `setInterval(cleanup, intervalMs)` 改为 ticker 链式单发。
- task id = `memory:cleanup`。

### C-7.4 其他

grep 结果剩余 `setInterval` 全在 `process-runtime/__tests__/*.ts` 作为测试 fixture
（子进程内部保活），不算业务定时器，保留不收编。

### C-7.5 约束

**Phase 4 结束后，`src/**/*.ts`（排除 __tests__）内禁止直接使用
`setInterval`。用 ESLint rule `no-restricted-syntax` 在 Wave 4 锁定。**

---

## C-8 · migration 契约

### C-8.1 SCHEMA_VERSION

`src/db/connection.ts` 的 `SCHEMA_VERSION` 从 `2` 改为 `3`，`SCHEMA_NOTE` 改为 `'action-items'`。

### C-8.2 新增 migration 文件

`src/db/migrations/2026-04-28-action-items.ts`，幂等模板（参考
`2026-04-27-sandbox-autoapprove.ts`）：
- 调 `sqlite_master` 检测 `action_items` 表是否存在。
- 不存在则执行 `schemas/action_items.sql`（与 applySchemas 合并执行路径互为备份）。
- 存在则跳过。
- migration 内不动 `messages` 表。

`connection.ts` 按序调用：
```ts
applySchemas(db);                    // 新库首次建表含 action_items
migrateMessagesEnvelope(db);
migrateMessagesDropInstanceFk(db);
migrateSandboxAutoApprove(db);
migrateRoleTemplatesAvatar(db);
migrateActionItems(db);              // Phase 4 新增
recordVersion(db);
```

### C-8.3 幂等判据

- 新库：`applySchemas` 建表 → `migrateActionItems` 检测表已存在 → 跳过。
- v2 老库：`applySchemas` 因 schema_version=2 已记录 **会跳过**（参考
  id:674 的优化路径），但因 `SCHEMA_VERSION` bump 到 3，`schemaAlreadyApplied`
  返回 false → `applySchemas` 重新执行 → 所有 `CREATE TABLE IF NOT EXISTS` 无副作用 →
  `migrateActionItems` 判表已存在 → 跳过 → `recordVersion` 写入 v3。
- v3 老库：`applySchemas` 跳过 → `migrateActionItems` 跳过 → `recordVersion` 判重跳过。

测试覆盖：`src/db/__tests__/connection-migration.test.ts` 验证
- 新库一次启动
- 假造 v2 db（插入 schema_version=2 + 建 messages 表缺 action_items）再启动
- 连续启动两次不报错

---

## C-9 · 事件 emit 与 WS 广播接线

- `action-item/repo.ts` 的 CRUD **不直接** emit bus 事件（保持 DAO 纯净，
  与 message-store 一致）。
- emit 点集中在 `action-item/service.ts`（Wave 3 新增）：
  create / claim / resolve / cancel / reschedule / reminder / timeout。
- `ws-broadcaster` 已有机制读取 `WS_EVENT_TYPES`；只要在 `ws/event-types.ts`
  追加 5 个事件即可自动进广播白名单。
- 守门测试 `ws/event-types.test.ts` 的 size 断言从 35 改到 40（35 + 5）。

---

## C-10 · 依赖关系速查

```
GlobalTicker (C-1)
  ↑
  ├─ ActionItemScheduler (C-6)
  │     ↑
  │     └─ ActionItem service (C-3, emit events C-4)
  │           ↑
  │           ├─ HTTP handler (C-3)
  │           └─ send_to_agent (C-5)
  ├─ CliManager (C-7.1)
  ├─ ParentWatcher (C-7.2)
  └─ MemoryManager (C-7.3)

ActionItemRepo (C-2) → getDb() → migration (C-8)
```
