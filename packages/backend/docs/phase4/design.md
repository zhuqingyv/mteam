# Phase 4 · 设计文档：GlobalTicker + ActionItem

> 状态：DRAFT v1 — 冻结于 2026-04-27
> 权威接口见 [`INTERFACE-CONTRACTS.md`](./INTERFACE-CONTRACTS.md)（本文件所有接口代码片段与其一致）。
> 任务清单见 [`TASK-LIST.md`](./TASK-LIST.md)。

---

## §1 需求总结

### 1.1 用户需求（原文）

**全局 Ticker（时间调度基础设施）**
- 整个应用只有一个定时器，启动时创建。
- 所有定时任务向 Ticker 注册，不允许各自 `setInterval`。
- 以绝对时间戳为准，每次醒来 `Date.now() >= task.fireAt` 判定，
  不累加 interval，不信 `setTimeout` 精度。
- Ticker 自适应休眠：取所有未触发任务中最近的 `fireAt`，零空转。
- event loop 阻塞晚醒了也不漏 — 醒来后批量触发所有已过期任务。
- 现有 setInterval（cliManager 30s、parent watcher 500ms 等）全部收编。

**ActionItem 统一待办**
- 独立一张表 `action_items`。
- kind：task / approval / decision / authorization。
- deadline：必填，绝对时间戳。
- status：pending → in_progress → done / rejected / timeout。
- assignee + creator。
- 剩余 ≤10% 时间 → comm 提醒 assignee。
- 超时 → status 改 timeout → comm 通知 creator。
- 不加新 MCP 工具，扩展 send_to_agent 的 kind + 加 deadline 字段。

**注意事项**
- SCHEMA_VERSION 要 bump（当前 2 → 3）。
- action_items 是独立新表，不改 messages 表。
- 测试要覆盖 DB migration 幂等。
- 不能因为加表导致前端无法响应。

### 1.2 本期范围

**要做：**
1. `src/ticker/` — GlobalTicker 单例 + 类型 + 单测。
2. `src/action-item/` — types / repo / scheduler / service + 单测。
3. `src/db/schemas/action_items.sql` + migration。
4. `/api/panel/action-items` HTTP 接口。
5. `action_item.*` WS 事件 5 条（加入白名单）。
6. `send_to_agent` / `send_msg` 扩展 kind + deadline。
7. 收编 CliManager / ParentWatcher / MemoryManager 的 setInterval。
8. 锁定 "业务代码不得直接 setInterval" 的 ESLint 规则。

**不做：**
- 不新增 MCP 工具（按用户需求）。
- 不改 messages 表（独立表）。
- 不引入 cron/quartz 类 DSL（不需要重复调度，Ticker 任务都是一次性，
  需要周期的在 onFire 内部链式 reschedule）。
- 不做优先级队列（现在任务量小，线性扫够）。

---

## §2 全局 Ticker 设计

### 2.1 设计原则

**单例 + 绝对时间戳 + 自适应休眠 + 批量触发 + 异常隔离。**

| 维度 | 方案 | 理由 |
|------|------|------|
| 实例数 | 进程全局单例 | 用户要求；避免多定时器抖动叠加。 |
| 时间判定 | `Date.now() >= fireAt` | 不信 `setTimeout` 精度；不累加漂移。 |
| 休眠策略 | `setTimeout(minFireAt - now)` | 零空转；只在"最近一个任务到期前"醒一次。 |
| 补偿策略 | 每次醒来批量触发所有过期任务 | event loop 阻塞 / 系统挂起不漏。 |
| 回调错误 | try/catch + stderr | 一个任务炸了不影响其他任务。 |
| 进程退出 | `timer.unref()` | 不阻塞 SIGINT / SIGTERM。 |
| 并发写 | 回调里 schedule/cancel 安全 | 本 tick 读快照，新增进下一轮。 |

### 2.2 接口（冻结，见 C-1.1）

```ts
schedule(task: TickerTask): void
cancel(id: TickerTaskId): void
has(id: TickerTaskId): boolean
start(): void
stop(): void
size(): number
```

**为何是一次性任务 + 链式 reschedule，而不是周期任务？**

周期任务看似简洁，但会在接口上引入"是否累加漂移 / 首次触发偏移 / 停止后是否补 tick"
等隐式歧义。一次性 task + 回调里自行 reschedule 更清晰：语义和重注册一致，
覆盖也用同一条 `schedule(same id)` 路径。代价是调用方多一行 `ticker.schedule(...)`，
但消费点少（本期 3 个系统 tick + ActionItemScheduler）。

### 2.3 自适应休眠伪码

```ts
class GlobalTickerImpl {
  private tasks = new Map<TickerTaskId, TickerTask>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  schedule(task) {
    this.tasks.set(task.id, task);
    if (this.running) this.armTimer();
  }
  cancel(id) {
    this.tasks.delete(id);
    if (this.running) this.armTimer();
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.armTimer();
  }
  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.tasks.clear();
  }

  private armTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.tasks.size === 0) return;
    const now = Date.now();
    let minFire = Infinity;
    for (const t of this.tasks.values()) if (t.fireAt < minFire) minFire = t.fireAt;
    const delay = Math.max(0, minFire - now);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private async tick() {
    if (!this.running) return;
    const now = Date.now();
    const due: TickerTask[] = [];
    for (const [id, t] of this.tasks) {
      if (t.fireAt <= now) { due.push(t); this.tasks.delete(id); }
    }
    for (const t of due) {
      try { await t.onFire(); } catch (e) {
        process.stderr.write(`[ticker] task ${t.id} failed: ${(e as Error).message}\n`);
      }
    }
    this.armTimer();  // 重新算下次休眠
  }
}
```

### 2.4 单测覆盖（Wave 1）

- 空 Ticker `start/stop` 不抛，`size()===0`。
- 注册未来任务：不触发；推进时间后触发一次；触发后 `has()` 返回 false。
- 注册过去 fireAt：下一 tick 立即触发。
- 同 id 重注册：覆盖 fireAt；旧回调不触发。
- 回调抛错：不影响其他任务，stderr 写入。
- 大量任务（100 条）：全部触发次数精确 100，无漏无重。
- event loop 阻塞（Bun 测试里 `await new Promise(r=>setImmediate(r))`
  + `mock.date`）晚醒批量触发。
- `stop()` 后再 schedule 不触发。

---

## §3 ActionItem 数据模型

详见 [INTERFACE-CONTRACTS C-2](./INTERFACE-CONTRACTS.md#c-2--actionitem-数据模型)。要点：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | TEXT PK | UUID v4 |
| kind | TEXT | task / approval / decision / authorization |
| title | TEXT NOT NULL | ≤ 200 |
| description | TEXT NOT NULL DEFAULT '' | ≤ 4000 |
| creator_kind + creator_id | TEXT×2 | user/agent/system + id |
| assignee_kind + assignee_id | TEXT×2 | 同上 |
| deadline | INTEGER | ms epoch，必填 |
| status | TEXT | pending / in_progress / done / rejected / timeout / cancelled |
| created_at / updated_at | INTEGER | ms epoch |
| reminded_at | INTEGER | NULL 表示未提醒 |
| resolution | TEXT | done 时结论 / rejected 时原因 |
| team_id | TEXT | 可空 |
| related_message_uuid | TEXT | 软关联 messages.envelope_uuid |

索引三条：`(assignee_kind, assignee_id, status)` / `(creator_kind, creator_id, status)` /
`(status, deadline)`。前两条支撑列表查询，第三条支撑 scheduler 扫描。

### 3.1 为什么不放 messages 表？

两个理由：
1. **字段语义不兼容**。messages 是"已发送事件流"（不可变），ActionItem 是
  "可变状态机"（status 会迁移）。混在一起等于在不可变流上加可变标志位。
2. **id:541 / id:383 有两次 messages migration 的教训**。messages 是核心热表，
  审查结论（id:664）明确反对再改。独立表是安全区。

### 3.2 软关联 messages

`related_message_uuid` 只做"前端点击 ActionItem 跳转到原始消息"用途，
不走 SQL JOIN，不建 FK。messages 清理不影响 ActionItem 表。

---

## §4 ActionItem 生命周期

```
               ┌──────────────────────────────────────┐
               │                                      │
 [create]  → pending ──[claim]─→ in_progress         │
               │                    │                │
               │[cancel]            │[resolve]       │
               ↓                    ↓                │
           cancelled            done / rejected      │
                                                     │
       at (deadline - 10% window) → reminder ────────┘ (不改状态)
       at deadline, 未终止 → timeout ────────────────┘
```

### 4.1 创建（create）

- 来源：HTTP POST / `send_to_agent` with kind ≠ chat。
- 事务：INSERT + `emit action_item.created`。
- 同步：`scheduler.rescheduleOne(id)` 给 Ticker 注册 reminder + timeout 两个 task。

### 4.2 认领（claim）

- assignee 调 POST `/:id/claim`，`pending` → `in_progress`，updated_at 刷新。
- emit `action_item.updated` with `changed=['status']`。
- 不动 reminder / timeout 调度（deadline 未变）。

### 4.3 提醒（reminder）

- 触发条件：`deadline - now <= (deadline - createdAt) * 0.1` 且 `reminded_at IS NULL`。
- Ticker 回调：
  1. `repo.update(id, { remindedAt: now })`。
  2. emit `action_item.reminder`。
  3. 通过 CommRouter 发 `system→assignee` 的 chat 消息：`summary="你的待办 '{title}' 还剩 X 分钟"`。
- 提醒路径**不创建新的 ActionItem**（防递归），kind='chat'。

### 4.4 解决（resolve）

- assignee 调 POST `/:id/resolve` with `outcome ∈ {done, rejected}`。
- 事务：`update(status=outcome, resolution=body.resolution)`。
- `scheduler.cancelOne(id)` 撤销 Ticker 上的 reminder + timeout。
- emit `action_item.resolved` with outcome。

### 4.5 撤回（cancel）

- creator 调 DELETE `/:id`。
- 事务：`update(status='cancelled')`。
- `scheduler.cancelOne(id)`。
- emit `action_item.resolved` with outcome='cancelled'（复用 resolved 事件）。

### 4.6 超时（timeout）

- Ticker 回调（fireAt = deadline）触发：
  1. 读 repo 当前状态；若已终止，静默返回（竞态防护）。
  2. `update(status='timeout')`。
  3. emit `action_item.timeout`。
  4. 通过 CommRouter 发 `system→creator` 的 chat 消息：`summary="待办 '{title}' 已超时未完成"`。

### 4.7 修改 deadline（可选能力，Wave 4 放入 stretch）

本期先不开放外部"修改 deadline"接口（用户需求未明确要）。
若未来接入：`update(deadline=new)` 后 `scheduler.rescheduleOne(id)` 即可。

---

## §5 send_to_agent / send_msg 扩展

### 5.1 schema 扩展

`kind` 联合从 `['chat','task']` 扩到 `['chat','task','approval','decision','authorization']`。
`deadline: number` 新增字段，kind=chat 时可省，其他 kind 必填且 `> now + 1000`。

### 5.2 工具入口改造

1. `src/mcp/tools/send_msg.ts`：扩 `ALLOWED_KINDS`，新增 `deadline` 解析与校验。
   投递成功后判 kind ≠ chat 则调 `actionItemService.createFromMessage(...)`。
2. `src/mcp-primary/tools/send_to_agent.ts`：schema 同步；底层调 `runSendMsg`，
   继承扩展后的行为。

### 5.3 teamId 推断

创建 ActionItem 时 `teamId` 由以下逻辑推断（顺序）：
1. caller 显式传入 teamId（HTTP 路径可选），直接用。
2. MCP 路径：读 `from` 和 `to` 对应 roster row 的 `team_id`；两者同 team → 用之；
   不同 team / 任一不在 team → `null`。
3. 都不满足 → `null`。

### 5.4 returnValue 兼容

- 旧：`{ delivered: true, to }`
- 新：`{ delivered: true, to, actionItemId: uuid | null }`，chat 时 `actionItemId = null`
  以保持键一致；旧调用方只读 `delivered/to` 不受影响。

### 5.5 MessageKind 扩展

`src/comm/envelope.ts` 的 `MessageKind` 类型扩展到 5 种。`message-store` 的 DB 列
无 CHECK 约束（参见 schemas/messages.sql），不需要 migration。类型级写入兼容。

---

## §6 ActionItem HTTP 接口

见 [INTERFACE-CONTRACTS C-3](./INTERFACE-CONTRACTS.md#c-3--http-接口apipanelaction-items)。

### 6.1 路由注册

`src/http/routes/action-items.routes.ts` 新增文件。
`src/http/router.ts` 追加：
```ts
import { handleActionItemsRoute } from './routes/action-items.routes.js';
// 分发（前缀匹配 /api/panel/action-items 优先于其他）：
if (pathname.startsWith('/api/panel/action-items')) {
  return handleActionItemsRoute(req);
}
```

### 6.2 handler 层次

- `api/panel/action-items.ts` — 业务层（service 组合 + 校验）。
- `http/routes/action-items.routes.ts` — HTTP 层（method + path + body 解析）。
- 与现有 `role-instances.ts / role-instances.routes.ts` 分层一致。

### 6.3 前端可用性

Wave 4 交付前测：
- 前端 roster 页保持可用（不因表增加阻塞启动）。
- 控制台报错扫描（playground CDP 流程，参考 id:Playground CDP 深度交互测试）。
- 若本期前端不接 ActionItem UI，则只验后端 + curl 走通。

---

## §7 ActionItem WS 事件

见 [INTERFACE-CONTRACTS C-4](./INTERFACE-CONTRACTS.md#c-4--ws-事件)。

### 7.1 落盘点

1. `src/bus/types.ts`：追加 `action_item.*` 5 类到 `BusEventType` 联合 + 5 个
   interface + `BusEvent` 总联合。
2. `src/ws/event-types.ts`：`WS_EVENT_TYPES` 追加 5 条。
3. `src/bus/subscribers/ws.subscriber.test.ts`：size 断言从 35 改到 40。

### 7.2 分发范围

沿用 ws-broadcaster 现有订阅分发。action-item 事件的"可见性"：
- creator (user/agent)：总能看到自己创建的 item 更新。
- assignee (user/agent)：总能看到分配给自己的 item 更新。
- 同 team 成员：可订阅 `scope=team` 观察团队内 ActionItem 流。

reminder 事件特殊处理：只发 assignee 一个维度，不给 creator 推（避免干扰）。
实现上在 `action-item/service.ts` 的 reminder 路径构造 event 时不带 teamId，
ws-broadcaster 按"只有 assignee 订阅的连接收到"的过滤逻辑分发。

---

## §8 ActionItemScheduler

见 [INTERFACE-CONTRACTS C-6](./INTERFACE-CONTRACTS.md#c-6--actionitemscheduler)。

### 8.1 职责

把 ActionItem 的 deadline / reminderAt 两个时间点映射到 Ticker 的 task。
`rescheduleOne(id)` 是唯一写接口：create / update deadline / claim 都可能调它。

### 8.2 启动顺序

```
index.ts boot():
  getDb()                              // migration
  ticker.start()                       // Wave 1 就绪
  cliManager.boot()                    // 向 ticker 注册 cli_scanner:poll
  memoryManager.start()                // 向 ticker 注册 memory:cleanup
  actionItemScheduler.start()          // 从 repo 读 pending 批量注册
  primaryAgent.boot()                  // 不动
  commServer.start()                   // 不动
```

### 8.3 启动期过期项处理

`start()` 遍历 repo.listAllActive()：
- deadline <= now：在下一 tick 立即触发 timeout 路径（通过 `ticker.schedule(fireAt=now)`）。
- reminder 窗口已过：只注册 timeout，不补发 reminder（防启动时轰炸）。
- 正常：同时注册 reminder + timeout。

### 8.4 解决后的清理

`resolve` / `cancel` / `timeout` 路径都调 `scheduler.cancelOne(id)`，
双保险：Ticker 回调自身再次读 repo 判已终止会 no-op。

---

## §9 现有 setInterval 收编方案

见 [INTERFACE-CONTRACTS C-7](./INTERFACE-CONTRACTS.md#c-7--现有-setinterval-收编)。

### 9.1 改造模板（链式单发）

以 CliManager 为例：

```ts
// 改造前
this.timer = setInterval(() => void this.poll(), 30_000);

// 改造后
private schedulePoll() {
  ticker.schedule({
    id: 'cli_scanner:poll',
    fireAt: Date.now() + 30_000,
    onFire: async () => {
      await this.poll();
      if (!this.stopped) this.schedulePoll();  // 链式
    },
  });
}
boot() { ...; this.schedulePoll(); }
teardown() { this.stopped = true; ticker.cancel('cli_scanner:poll'); }
```

### 9.2 ParentWatcher 特殊性

ParentWatcher 是"纯函数 + 零业务 import"模块。收编后依然保持：
- 不 import bus。
- `ticker` 通过 `opts.ticker` 可注入，默认读单例。
- 测试注入 mock ticker 验 500ms 链式 reschedule。

### 9.3 锁定规则

`.eslintrc` 或等效配置添加：

```jsonc
{
  "rules": {
    "no-restricted-syntax": [
      "error",
      {
        "selector": "CallExpression[callee.name='setInterval']",
        "message": "业务代码禁止直接使用 setInterval，请向 ticker 注册任务（src/ticker/ticker.ts）"
      }
    ]
  },
  "overrides": [
    { "files": ["**/__tests__/**", "**/*.test.ts"], "rules": { "no-restricted-syntax": "off" } }
  ]
}
```

Wave 4 交付前跑一次 `bunx eslint src` 验证零违反。

---

## §10 模块拆分 + 文件结构

```
packages/backend/
├── docs/phase4/
│   ├── design.md                                      (本文件)
│   ├── TASK-LIST.md
│   └── INTERFACE-CONTRACTS.md
├── src/
│   ├── ticker/                                        (新增)
│   │   ├── types.ts                 ≤ 80 行  — TickerTask / GlobalTicker 类型
│   │   ├── ticker.ts                ≤ 150 行 — GlobalTickerImpl + export const ticker
│   │   └── __tests__/ticker.test.ts ≤ 200 行 — 8 组场景
│   ├── action-item/                                   (新增)
│   │   ├── types.ts                 ≤ 100 行 — ActionItem / ActorId / 状态枚举
│   │   ├── repo.ts                  ≤ 200 行 — createActionItemRepo()
│   │   ├── service.ts               ≤ 200 行 — create / claim / resolve / cancel / reminder / timeout
│   │   ├── scheduler.ts             ≤ 150 行 — rescheduleOne / cancelOne / start / stop
│   │   └── __tests__/
│   │       ├── repo.test.ts
│   │       ├── service.test.ts
│   │       └── scheduler.test.ts
│   ├── db/
│   │   ├── schemas/action_items.sql                   (新增)
│   │   └── migrations/2026-04-28-action-items.ts      (新增)
│   ├── api/panel/action-items.ts                      (新增 — 业务校验)
│   ├── http/routes/action-items.routes.ts             (新增 — 路由)
│   ├── bus/types.ts                                   (改 — +5 event types)
│   ├── ws/event-types.ts                              (改 — 白名单 +5)
│   ├── mcp/tools/send_msg.ts                          (改 — kind/deadline)
│   ├── mcp-primary/tools/send_to_agent.ts             (改 — schema 同步)
│   ├── cli-scanner/manager.ts                         (改 — 收编 setInterval)
│   ├── process-manager/parent-watcher.ts              (改 — 收编 setInterval)
│   ├── memory-manager/manager.ts                      (改 — 收编 setInterval)
│   └── index.ts                                       (改 — 启动顺序)
```

行数红线：单文件 ≤ 200 行（与项目现有约束一致）；超 200 需在文件顶部注释记账。

---

## §11 Wave 分层 + 任务拆解

### 11.1 Wave 概念

- **Wave 1 — 独立基础设施**：无业务依赖，可并行开发。
- **Wave 2 — 数据层**：依赖 Wave 1 的 Ticker，不依赖上层业务。
- **Wave 3 — 服务层 + 接口**：依赖 Wave 2 的 repo，开始组装业务流。
- **Wave 4 — 胶水 + 收编 + 守门**：把旧 setInterval 收进来，跑 e2e 测试。

### 11.2 Wave 1（可并行 3 人）

| # | 任务 | 文件 |
|---|------|------|
| T1.1 | GlobalTicker 类型 | `src/ticker/types.ts` |
| T1.2 | GlobalTickerImpl 实现 + 单例 | `src/ticker/ticker.ts` |
| T1.3 | Ticker 单测 8 组场景 | `src/ticker/__tests__/ticker.test.ts` |
| T1.4 | action_items.sql | `src/db/schemas/action_items.sql` |
| T1.5 | ActionItem 类型 | `src/action-item/types.ts` |
| T1.6 | `bus/types.ts` 加 5 event + `ws/event-types.ts` 白名单 +5 + 守门测试更新 | 3 改 1 测 |
| T1.7 | send_msg schema 扩展（仅 schema，不接 service） | `src/mcp/tools/send_msg.ts` |

### 11.3 Wave 2（依赖 Wave 1；可并行 2 人）

| # | 任务 | 依赖 |
|---|------|------|
| T2.1 | migration + SCHEMA_VERSION bump + migration 测试 | T1.4 |
| T2.2 | ActionItemRepo 实现 + 单测 | T1.5 + T2.1 |

### 11.4 Wave 3（依赖 Wave 2）

| # | 任务 | 依赖 |
|---|------|------|
| T3.1 | ActionItemService（create/claim/resolve/cancel + emit bus） | T2.2 |
| T3.2 | ActionItemScheduler（Ticker 接线 + reminder/timeout 路径） | T1.2, T3.1 |
| T3.3 | `/api/panel/action-items` HTTP handler + 单测 | T3.1 |
| T3.4 | `send_msg` / `send_to_agent` 接 ActionItemService | T1.7, T3.1 |

### 11.5 Wave 4（胶水 + 收编 + 门禁）

| # | 任务 | 依赖 |
|---|------|------|
| T4.1 | CliManager 收编 setInterval | T1.2 |
| T4.2 | ParentWatcher 收编 setInterval | T1.2 |
| T4.3 | MemoryManager 收编 setInterval | T1.2 |
| T4.4 | `index.ts` 启动顺序 + ticker.start() + scheduler.start() | T3.2, T4.1-3 |
| T4.5 | ESLint no-restricted-syntax 锁 setInterval | T4.1-3 |
| T4.6 | e2e：创建 → 认领 → 超时路径 / 创建 → resolve 路径 | T4.4 |
| T4.7 | 前端可响应回归（CDP 启动一次 playground） | T4.4 |

### 11.6 跨 Wave 守门

每个 Wave 完成时由"交付前自检"committer 对照本 design 的判据逐条贴证据
（参考 feedback_self_check.md）：
- Wave 1：所有类型/接口文件编译通过；单测独立可运行。
- Wave 2：migration 三场景（新库/v2老库/v3老库）测试全绿；repo CRUD 全绿。
- Wave 3：service 单测；HTTP 用 curl 走 5 个接口全通；send_msg 扩展不回归老行为。
- Wave 4：`bunx eslint src` 零警告；e2e reminder/timeout/resolve 走通；前端可响应。

---

## §12 风险与回退

### 12.1 风险

| 风险 | 等级 | 对策 |
|------|------|------|
| migration 改 SCHEMA_VERSION 影响老库 | 高 | Wave 2 T2.1 专门单测 3 场景 |
| Ticker 单例在多实例进程（worker）失效 | 低 | 本项目单进程架构，不适用 |
| reminder 阈值 10% 对短 deadline 太近 | 中 | 若 `deadline - createdAt < 60s`，强制 reminder 在 deadline 前 10s 触发 |
| send_msg 回归老调用（kind=chat 无 deadline） | 中 | 扩展时 kind=chat 不校验 deadline；加回归测试 |
| 前端未更新时后端加表导致启动变慢 | 低 | applySchemas 只多一张小表；SCHEMA_VERSION 命中后走 skip 快路径 |

### 12.2 回退

Phase 4 所有改动可通过回滚 commit + 跑一次 `getDb()` 回退：
- `action_items` 表保留不删（SQLite 不自动清，下次启动会被 v3 识别）。
- 代码回退后 SCHEMA_VERSION=2，`applySchemas` 跳过不重建；老数据不丢。
- 若需清理：手动 `DROP TABLE action_items` + `DELETE FROM schema_version WHERE version=3`。

---

## §13 变更记录

| 日期 | 作者 | 说明 |
|------|------|------|
| 2026-04-27 | team-lead | v1 — 初版设计 / 接口冻结 |
