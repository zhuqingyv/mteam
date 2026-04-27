# Phase 4 · TASK-LIST

> 冻结于 2026-04-27。所有任务按 Wave 并行执行；同 Wave 内无依赖。
> 判据 = 本任务的"done definition"；交付前由执行者逐条贴证据（截图 / 命令输出 / 测试结果）。
> 所有接口引用 [`INTERFACE-CONTRACTS.md`](./INTERFACE-CONTRACTS.md)；偏离视为违约。

---

## Wave 1 · 独立基础设施（并行 3 人）

---

### T1.1 · GlobalTicker 类型定义

- **描述**：落盘 `src/ticker/types.ts`，定义 `TickerTask` / `GlobalTicker` / `TickerTaskId`。
- **Wave**：1
- **判据**：
  - [ ] 文件存在，≤ 80 行。
  - [ ] 类型与 INTERFACE-CONTRACTS C-1.1 完全一致（方法签名、字段名、字段类型）。
  - [ ] `bun tsc --noEmit` 通过（只 import type，不 import 运行时）。
- **依赖**：无。

---

### T1.2 · GlobalTicker 实现 + 单例

- **描述**：实现 `src/ticker/ticker.ts` 的 `GlobalTickerImpl` class；导出 `export const ticker`。
- **Wave**：1
- **判据**：
  - [ ] `GlobalTickerImpl` 实现 `GlobalTicker` 的全部 6 个方法。
  - [ ] 绝对时间戳判定：`Date.now() >= fireAt`；实现中无任何 `fireAt + interval` 累加写法。
  - [ ] 自适应休眠：空任务集不设 timer；`armTimer()` 在 schedule/cancel/tick 结束后调用。
  - [ ] 批量触发：一次 tick 处理所有 `fireAt <= now` 的任务。
  - [ ] `timer.unref?.()` 已调。
  - [ ] 单 task 抛错 / Promise reject 不影响其他 task；stderr 写入失败日志。
  - [ ] `start()` 幂等；`stop()` 清空 tasks 并 clearTimeout。
  - [ ] `bun tsc --noEmit` 通过。
- **依赖**：T1.1。

---

### T1.3 · Ticker 单测

- **描述**：`src/ticker/__tests__/ticker.test.ts`，覆盖 8 组场景。
- **Wave**：1
- **判据**：
  - [ ] 空 ticker `start/stop` 不抛。
  - [ ] 注册未来 task：推进时间后恰好触发一次；`has()` 返回 false。
  - [ ] 注册已过期 fireAt：下一 tick 立即触发。
  - [ ] 同 id 重注册：旧回调不被调用，新 fireAt 生效。
  - [ ] 回调抛错不影响其他回调。
  - [ ] 100 条任务批量：回调总次数精确 100。
  - [ ] 模拟 event loop 被 200ms 阻塞后：所有过期任务批量触发。
  - [ ] `stop()` 后再 schedule 不触发。
  - [ ] `bun test src/ticker/__tests__/ticker.test.ts` 全绿。
- **依赖**：T1.2。

---

### T1.4 · action_items.sql schema

- **描述**：`src/db/schemas/action_items.sql`，见 INTERFACE-CONTRACTS C-2.2。
- **Wave**：1
- **判据**：
  - [ ] `CREATE TABLE IF NOT EXISTS action_items(...)` 字段与 C-2.2 完全一致。
  - [ ] 3 条索引齐全（assignee/creator/status-deadline）。
  - [ ] CHECK 约束 4 处（kind / creator_kind / assignee_kind / status）。
  - [ ] 本地手动 `sqlite3 < action_items.sql` 无错。
- **依赖**：无。

---

### T1.5 · ActionItem 类型

- **描述**：`src/action-item/types.ts`，导出 `ActionItemKind / ActionItemStatus / ActorId / ActionItem`。
- **Wave**：1
- **判据**：
  - [ ] 类型与 INTERFACE-CONTRACTS C-2.1 完全一致。
  - [ ] 仅 type / interface，无运行时代码。
  - [ ] `bun tsc --noEmit` 通过。
- **依赖**：无。

---

### T1.6 · bus/ws 事件注册（+5）

- **描述**：改 `src/bus/types.ts`（`BusEventType` 联合 +5、新增 5 个 interface、`BusEvent` 联合 +5）；
  改 `src/ws/event-types.ts`（白名单 +5）；改 `src/bus/subscribers/ws.subscriber.test.ts`（size 断言 35→40）；
  改 `src/ws/__tests__/event-types.test.ts` 若存在（同步 size 断言）。
- **Wave**：1
- **判据**：
  - [ ] 5 条事件类型字符串：`action_item.created` / `action_item.updated` / `action_item.reminder` / `action_item.resolved` / `action_item.timeout`。
  - [ ] 5 个 interface 字段与 C-4.2 完全一致。
  - [ ] `BusEvent` 总联合含新 5 项。
  - [ ] `WS_EVENT_TYPES.size === 40`。
  - [ ] 守门测试跑绿：`bun test src/bus/subscribers/ws.subscriber.test.ts`。
  - [ ] `bun tsc --noEmit` 通过。
- **依赖**：T1.5（payload 里引用 ActionItem 类型）。

---

### T1.7 · send_msg / send_to_agent schema 扩展（仅 schema）

- **描述**：`src/mcp/tools/send_msg.ts` + `src/mcp-primary/tools/send_to_agent.ts` 的
  inputSchema 把 `kind` enum 扩到 5 种；新增 `deadline: number`。运行时校验本任务只加"字段长度 / 类型"最小校验，
  **不接 ActionItemService**（service 未落地）。kind ≠ chat 且 deadline 缺失时返回 error；
  kind = chat 时 deadline 可省，行为与旧版一致。
- **Wave**：1
- **判据**：
  - [ ] `ALLOWED_KINDS` 联合含 `chat / task / approval / decision / authorization`。
  - [ ] schema 里 `deadline` 字段存在，description 注明"Absolute ms epoch"。
  - [ ] kind=chat 时 deadline 缺省不报错，行为同旧版。
  - [ ] kind ≠ chat 且 deadline 缺失：返回 `{ error: '...' }`，不投递消息。
  - [ ] kind ≠ chat 且 deadline ≤ now + 1000：返回 error。
  - [ ] 新增单测覆盖上述 3 分支；旧测试全绿。
- **依赖**：无（service 不依赖；运行时暂不创建 ActionItem）。

---

## Wave 2 · 数据层（依赖 Wave 1；并行 2 人）

---

### T2.1 · migration + SCHEMA_VERSION bump + migration 测试

- **描述**：
  - 改 `src/db/connection.ts`：`SCHEMA_VERSION` 2→3；`SCHEMA_NOTE` `'action-items'`。
  - 新增 `src/db/migrations/2026-04-28-action-items.ts`（参考 `2026-04-27-sandbox-autoapprove.ts` 模板）。
  - 在 `connection.ts` 的 `getDb()` 按序追加 `migrateActionItems(db)`。
  - 新增 `src/db/__tests__/migration-action-items.test.ts`（三场景）。
- **Wave**：2
- **判据**：
  - [ ] `SCHEMA_VERSION === 3` 且 `SCHEMA_NOTE === 'action-items'`。
  - [ ] `migrateActionItems` 幂等：表不存在时 CREATE；表存在时 no-op；连续调用 2 次不抛。
  - [ ] 场景 A 新库 `:memory:`：启动后 `PRAGMA table_info(action_items)` 返回 14 列，schema_version 记录 v3。
  - [ ] 场景 B 假造 v2 库（手动插入 schema_version=2 + messages 表）：启动后 action_items 表被建出，schema_version 新增 v3 行。
  - [ ] 场景 C 连续启动两次：第二次启动不抛，schema_version 仍只有 v3 一行（幂等写入）。
  - [ ] `bun test src/db/__tests__/migration-action-items.test.ts` 全绿。
- **依赖**：T1.4。

---

### T2.2 · ActionItemRepo 实现 + 单测

- **描述**：`src/action-item/repo.ts` + `src/action-item/__tests__/repo.test.ts`。
- **Wave**：2
- **判据**：
  - [ ] `createActionItemRepo()` 返回对象实现 INTERFACE-CONTRACTS C-2.3 的全部方法。
  - [ ] `create` 输入带/不带 id 都能用（不带则内部生成 UUID v4）；
    回填 `createdAt / updatedAt / status='pending' / remindedAt=null`。
  - [ ] `update` 支持部分字段更新；id 不存在抛 Error。
  - [ ] `listByAssignee / listByCreator`：按 `(assignee_kind, assignee_id, status)` 索引走，
    status 不传则返回所有；默认 limit=50 上限 200。
  - [ ] `findNextDeadline` 返回 status ∈ {pending, in_progress} 中 deadline 最小的行。
  - [ ] `findOverdue(now)` 返回所有 status ∈ {pending, in_progress} 且 deadline ≤ now。
  - [ ] `findDueForReminder(now)` 返回所有 status ∈ {pending, in_progress} 且 remindedAt IS NULL 且
    `deadline - now <= (deadline - createdAt) * 0.1`。
  - [ ] 单测覆盖每个方法 + 3 条边界（空表 / 已终止 / 大量行）。
  - [ ] `bun test src/action-item/__tests__/repo.test.ts` 全绿。
- **依赖**：T1.5, T2.1。

---

## Wave 3 · 服务层 + 接口（依赖 Wave 2；并行 2 人）

---

### T3.1 · ActionItemService（create / claim / resolve / cancel + emit）

- **描述**：`src/action-item/service.ts` + `__tests__/service.test.ts`。组合 repo + bus，
  落盘 CRUD + emit 对应事件。暴露 `createActionItemService({ repo, bus, ticker, commRouter })`。
- **Wave**：3
- **判据**：
  - [ ] `create(input)`：repo.create → scheduler.rescheduleOne → emit `action_item.created`。
  - [ ] `claim(id, by)`：repo.update status=in_progress；emit `action_item.updated` changed=['status']；
    非 assignee 调用抛 `ForbiddenError`。
  - [ ] `resolve(id, outcome, resolution)`：repo.update → scheduler.cancelOne → emit `action_item.resolved`。
  - [ ] `cancel(id, by)`：仅 creator 能调；repo.update status=cancelled → scheduler.cancelOne → emit `action_item.resolved` outcome=cancelled。
  - [ ] `reminder(id)`：service 内部调用；repo.update(remindedAt=now) → emit `action_item.reminder` → commRouter.dispatch system→assignee。
  - [ ] `timeout(id)`：读当前状态，若已终止则 no-op；否则 repo.update status=timeout → emit `action_item.timeout` → commRouter.dispatch system→creator。
  - [ ] 单测用 fake bus + fake commRouter + 真实 repo（:memory: db）；覆盖所有分支。
  - [ ] `bun test src/action-item/__tests__/service.test.ts` 全绿。
- **依赖**：T2.2, T1.6。

---

### T3.2 · ActionItemScheduler

- **描述**：`src/action-item/scheduler.ts` + `__tests__/scheduler.test.ts`。
- **Wave**：3
- **判据**：
  - [ ] `start()` 从 repo.listAllActive() 遍历，为每个 item 调用 `rescheduleOne(id)`。
  - [ ] `rescheduleOne(id)`：
    - 读 repo 当前行；若已终止则 no-op。
    - reminderAt = `deadline - (deadline - createdAt) * 0.1`；
      若 `deadline - createdAt < 60_000` 则 reminderAt = deadline - 10_000。
    - 若 remindedAt 已有值，不再注册 reminder。
    - 注册 `action_item:reminder:<id>` fireAt=reminderAt（<= now 则用 now + 1）。
    - 注册 `action_item:timeout:<id>` fireAt=deadline。
  - [ ] `cancelOne(id)` 调 ticker.cancel(两个 id)。
  - [ ] 启动期：过期 item 只注册 timeout（立即触发路径），不补 reminder。
  - [ ] 单测用 fake ticker + 真实 repo；覆盖 create/过期/已提醒/短 deadline 4 场景。
  - [ ] `bun test src/action-item/__tests__/scheduler.test.ts` 全绿。
- **依赖**：T1.2, T3.1。

---

### T3.3 · `/api/panel/action-items` HTTP handler

- **描述**：
  - 新增 `src/api/panel/action-items.ts`（业务校验层）。
  - 新增 `src/http/routes/action-items.routes.ts`（HTTP 层）。
  - 改 `src/http/router.ts` 分发 `/api/panel/action-items*`。
  - 新增 `src/http/__tests__/http-action-items.test.ts`。
- **Wave**：3
- **判据**：
  - [ ] 5 个端点全通，与 INTERFACE-CONTRACTS C-3 完全一致：
    - POST / 创建（201）。
    - GET / 列表（200）。
    - POST /:id/claim（200 / 403 / 409）。
    - POST /:id/resolve（200 / 409 / 400 missing resolution for rejected）。
    - DELETE /:id（200 / 403 / 409）。
  - [ ] 400 / 403 / 404 / 409 分支有测试覆盖。
  - [ ] `deadline > now + 1000` 校验生效。
  - [ ] body 上限 16KB 保护（参考现有 routes 写法）。
  - [ ] 手动 curl 跑通 5 个端点并贴输出到交付。
  - [ ] `bun test src/http/__tests__/http-action-items.test.ts` 全绿。
- **依赖**：T3.1。

---

### T3.4 · send_msg / send_to_agent 接 ActionItemService

- **描述**：改 `src/mcp/tools/send_msg.ts`：kind ≠ chat 且投递成功后调 service.create；
  `send_to_agent.ts` 复用 runSendMsg 自动继承。
- **Wave**：3
- **判据**：
  - [ ] kind=chat 行为与旧版 100% 一致；不创建 ActionItem；返回值 `actionItemId=null`。
  - [ ] kind ∈ {task, approval, decision, authorization}：投递成功后调 service.create；
    返回值含 `actionItemId=<uuid>`。
  - [ ] 投递失败（comm.send 抛）：不创建 ActionItem；返回 error。
  - [ ] teamId 推断（见 design §5.3）正确：同 team from/to 命中；跨 team 为 null。
  - [ ] 新增 3 组单测：chat 分支 / kind=task 分支 / 投递失败回滚分支。
  - [ ] `bun test src/mcp/__tests__/send-msg.test.ts` 全绿（含新老用例）。
- **依赖**：T1.7, T3.1。

---

## Wave 4 · 胶水 + 收编 + 守门

---

### T4.1 · CliManager 收编 setInterval

- **描述**：改 `src/cli-scanner/manager.ts`：删除 `setInterval` 路径，改链式 `ticker.schedule`。
  id=`cli_scanner:poll`，interval=30_000。
- **Wave**：4
- **判据**：
  - [ ] 文件内零 `setInterval`（grep 确认）。
  - [ ] `boot()` 首次 scan 完成后注册一次 ticker task。
  - [ ] `onFire` 内 `await poll()` → 若未 stopped 则 reschedule。
  - [ ] `teardown()` 调 `ticker.cancel('cli_scanner:poll')`。
  - [ ] 既有 `cli-scanner.test.ts` 全绿；新增 1 个测试断言"tick 触发 scanAndDiff"。
- **依赖**：T1.2。

---

### T4.2 · ParentWatcher 收编 setInterval

- **描述**：改 `src/process-manager/parent-watcher.ts`：保持纯函数 API；
  新增 `opts.ticker` 注入（默认读单例）。
- **Wave**：4
- **判据**：
  - [ ] 文件内零 `setInterval`。
  - [ ] watchParentAlive 返回的 `ParentWatcher.stop()` 调 `ticker.cancel('process:parent_watch')`。
  - [ ] 链式 reschedule 间隔严格 500ms（用 ticker fireAt 算，非 setInterval）。
  - [ ] 不 import bus / 业务。
  - [ ] 既有 `parent-watcher.test.ts` 全绿（mock ticker）；新增 1 个测试断言 500ms 周期。
- **依赖**：T1.2。

---

### T4.3 · MemoryManager 收编 setInterval

- **描述**：改 `src/memory-manager/manager.ts`：把 `setInterval(cleanup, ...)` 改链式 ticker task。
  id=`memory:cleanup`。
- **Wave**：4
- **判据**：
  - [ ] 文件内零 `setInterval`。
  - [ ] `start()` 注册一次 ticker task；`stop()` cancel。
  - [ ] 既有 memory-manager 测试全绿。
- **依赖**：T1.2。

---

### T4.4 · index.ts 启动顺序

- **描述**：改 `src/index.ts` 的 boot 流程；按 design §8.2 顺序调用：
  `getDb() → ticker.start() → cliManager.boot() → memoryManager.start() → actionItemScheduler.start() → primaryAgent.boot() → commServer.start()`。
- **Wave**：4
- **判据**：
  - [ ] 顺序与 design §8.2 一致。
  - [ ] 进程退出路径（SIGINT/SIGTERM）调用 `actionItemScheduler.stop()` + `ticker.stop()` + 其他 teardown。
  - [ ] 启动跑 `bun run src/index.ts`，stderr 无 fatal；ps 看只有一个 Node 进程、一个 setTimeout（Ticker）。
- **依赖**：T3.2, T4.1, T4.2, T4.3。

---

### T4.5 · ESLint no-restricted-syntax 锁

- **描述**：改 `.eslintrc.*` 或等效配置加 `no-restricted-syntax` 禁止业务代码直接 `setInterval`；
  `__tests__/` overrides 关闭。
- **Wave**：4
- **判据**：
  - [ ] `bunx eslint src` 零错误（排除测试）。
  - [ ] 手动在 src 下试写一处 `setInterval(...)` 能被 lint 抓到（验证后回退）。
  - [ ] package.json 的 lint 脚本跑通。
- **依赖**：T4.1, T4.2, T4.3。

---

### T4.6 · e2e：创建 → 超时 / 创建 → resolve

- **描述**：`src/__tests__/action-items-e2e.test.ts`。用真实 HTTP 服务器 + 真实 Ticker + `:memory:` DB。
- **Wave**：4
- **判据**：
  - [ ] 场景 1：POST create(kind=task, deadline=now+500ms) → wait 600ms → GET list → 状态=timeout；
    捕获到 `action_item.timeout` 事件。
  - [ ] 场景 2：POST create(deadline=now+10_000) → POST claim → POST resolve(done) →
    GET → status=done；scheduler 取消；Ticker 上无残留。
  - [ ] 场景 3：POST create(deadline=now+200ms，创建时 createdAt=now) → wait 180ms → 捕获 `action_item.reminder` 事件（窗口10s + 短deadline fallback）。
  - [ ] 场景 4：send_msg kind=task → GET list 能找到新 item，关联 messageId 正确。
  - [ ] `bun test src/__tests__/action-items-e2e.test.ts` 全绿。
- **依赖**：T4.4。

---

### T4.7 · 前端可响应回归

- **描述**：启动 backend + playground，用 CDP 流程（参考 project_playground_cdp_testing.md）
  确认前端未因加表/加事件崩溃。
- **Wave**：4
- **判据**：
  - [ ] Playground 首页打开，无红色 console error。
  - [ ] Roster 页能拉 roster（原有功能）。
  - [ ] WS 连上后收到 ≥1 条现有事件（心跳或 instance.* 广播）。
  - [ ] 贴 CDP 截图 + 控制台无 error 证据到交付清单。
- **依赖**：T4.4。

---

## 任务依赖图（ASCII）

```
Wave 1:  T1.1 ── T1.2 ── T1.3
         T1.4
         T1.5 ── T1.6
         T1.7

Wave 2:  T2.1 ←── T1.4
         T2.2 ←── T1.5 + T2.1

Wave 3:  T3.1 ←── T2.2 + T1.6
         T3.2 ←── T1.2 + T3.1
         T3.3 ←── T3.1
         T3.4 ←── T1.7 + T3.1

Wave 4:  T4.1 ←── T1.2
         T4.2 ←── T1.2
         T4.3 ←── T1.2
         T4.4 ←── T3.2 + T4.1 + T4.2 + T4.3
         T4.5 ←── T4.1 + T4.2 + T4.3
         T4.6 ←── T4.4
         T4.7 ←── T4.4
```

---

## 交付前自检清单（委派到交付者）

- [ ] 每个 Wave 结束时对照本文件判据逐条贴证据（命令输出 / 测试通过截图）。
- [ ] 全部 Wave 完成后：
  - [ ] `bun test` 全绿（backend 包）。
  - [ ] `bun tsc --noEmit`（backend 包）零错误。
  - [ ] `bunx eslint src` 零错误。
  - [ ] 启动 backend + playground 实测前端可响应。
  - [ ] `bunx grep -rn "setInterval" src/` 排除 `__tests__/` 零命中。
  - [ ] curl 5 个 `/api/panel/action-items` 端点贴输出。
  - [ ] e2e 测试 4 场景均有输出/断言证据。
