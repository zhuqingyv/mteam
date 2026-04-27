# Phase WS-Primary · TASK-LIST

> 目标：主 Agent 完全 WS 化 — 前端不再对主 Agent 发 HTTP，启停走应用生命周期，切 CLI / 查状态全走 WS 上下行。
>
> 用户原话（不得擅改）：
> 1. "主Agent没有对前端停止的接口，应用启动主Agent就启动，应用停止主Agent就关掉"
> 2. "中间主Agent切换agent类型，主Agent重启"
> 3. "全部是ws推送和更新状态，包括对话"
> 4. "前端往往快，agent相关的直接改成ws推送"

## 现状快照（改前必读）

| 条目 | 现状 | 证据 |
|---|---|---|
| 主 Agent 启动 | 已在 `http/server.ts:120` 内 `primaryAgent.boot()` 自动拉起，不依赖前端 | `packages/backend/src/http/server.ts:120` |
| 主 Agent 停止 | 已在 `shutdown` 里 `primaryAgent.teardown()`，进程退时自动停 | `packages/backend/src/http/server.ts:143` |
| Electron 退出 | `before-quit` / `window-all-closed` → `stopBackend()` → 后端 `shutdown()` | `packages/renderer/electron-main/main.ts:111-118` |
| 切 CLI 重启 | `primaryAgent.configure()` 内 `cliChanged && driver → stop/start`，事件已 emit | `packages/backend/src/primary-agent/primary-agent.ts:56-62` |
| 生命周期事件 | `primary_agent.started / stopped / configured` 已通过 WS 白名单广播 | `packages/backend/src/bus/types.ts:39-41, 212-226` |
| 前端查当前状态 | **还靠 HTTP** `GET /api/primary-agent` | `docs/frontend-api/INDEX.md:131` |
| 前端切 CLI | **还靠 HTTP** `POST /api/primary-agent/config` | `docs/frontend-api/INDEX.md:132` |
| 前端启停 | **还在调** `POST /api/primary-agent/start|stop` | `docs/frontend-api/INDEX.md:133-134` |

结论：**启停自动化已具备 → 只剩两件事要改**

1. 前端连上 WS 后需要知道**当前状态** → 新增下行 `snapshot`
2. 前端需要一条 op 切 CLI → 新增上行 `configure`

**"废弃 vs 保留" 统一口径（全文生效）**：所有 `/api/primary-agent*` 端点均 **"前端废弃（primary-agent renderer 里删干净），后端保留供调试"**。后端代码、HTTP 测试、路由注册均不动；仅前端 primaryAgentStore / hooks 侧清理调用。

## 拆分原则

- **Wave 1（非业务，纯类型/协议/守卫）**：`ws/protocol.ts` 加新 op + 下行类型 + 类型守卫。可独立单测，不依赖 primaryAgent。
- **Wave 2（业务胶水）**：`ws-handler.ts` 路由 configure op → primaryAgent.configure；`ws-upgrade.ts` 连接建立时推快照；前端文档更新。

每文件 ≤ 200 行。改动只允许"新增"，不动现有 subscribe/unsubscribe/prompt/ping 路径。

---

## Wave 1 · 非业务（可并行）

### W1-A · protocol.ts 扩展上行 `configure` + 下行 `snapshot`

**文件**：`packages/backend/src/ws/protocol.ts`

**新增上行类型**：

```ts
export interface WsConfigurePrimaryAgent {
  op: 'configure_primary_agent';
  /** 目标 CLI；目前实现接收 'claude' | 'codex'，协议层只收窄为非空 string，业务层拒未知值。 */
  cliType: string;
  /** 可选；沿用 PrimaryAgentConfig 其他字段，仅 name/systemPrompt 放开，其他收紧到后续迭代。 */
  name?: string;
  systemPrompt?: string;
  requestId?: string;
}
```

并入 `WsUpstream` 联合 → `isWsUpstream` 的 switch 增加 `'configure_primary_agent'` 分支，额外字段一律拒（与 W1-A 已有守卫风格一致）。

**新增下行类型**：

```ts
// 见 `primary-agent/types.ts`：PrimaryAgentRow 是唯一真值形态。
import type { PrimaryAgentRow } from '../primary-agent/types.js';

export interface WsSnapshot {
  type: 'snapshot';
  /** 未配置返回 null；配置后返回完整 PrimaryAgentRow（与 `GET /api/primary-agent` 等价）。 */
  primaryAgent: PrimaryAgentRow | null;
}
```

并入 `WsDownstream` 联合。**仅定义类型 + 守卫**，运行时构造在 W2-B。

> **为什么是完整 Row 不是子集**：HTTP `GET /api/primary-agent` 返回完整 row（`id/name/cliType/systemPrompt/mcpConfig/status/createdAt/updatedAt`）；snapshot 是 GET 的 WS 等价物，字段必须 1:1。前端 `primaryAgentStore` 已按 PrimaryAgentRow 绑定（见知识 #512/#517），载荷收窄会破坏既有 store。

> **`status` 对齐现实**：`PrimaryAgentRow.status = 'STOPPED' | 'RUNNING'`（见 `packages/backend/src/primary-agent/types.ts:9`）。仓库内**不存在** `status='ERROR'` 的写入点 — driver 崩溃走 `self-heal` 重试，give_up 时 `setStatus(id,'STOPPED')`（见 `primary-agent.ts:163, 174`）。本协议严禁引入 ERROR 字面量，避免前端 switch 兜一个永远不会发的分支。

**完成判据**：
- [ ] `ws/protocol.test.ts` 新增 6 条：合法 configure / 缺 cliType / 空字符串 cliType / 多余字段 / 合法 configure 带 name+systemPrompt / 非 object。
- [ ] `isWsUpstream({ op:'configure_primary_agent', cliType:'codex' })` 返回 true。
- [ ] `isWsUpstream({ op:'configure_primary_agent', cliType:'' })` 返回 false。
- [ ] 现有 subscribe/unsubscribe/prompt/ping 测试全绿。
- [ ] 文件 ≤ 200 行。

**非改动清单（红线）**：不动 `WsPrompt / WsSubscribe / WsUnsubscribe / WsPing`；不动 `SubscriptionScope / WsErrorCode`；不 import 业务模块。

---

### W1-B · snapshot builder 纯函数（不碰 ws-upgrade）

**文件（新建）**：`packages/backend/src/ws/snapshot-builder.ts`

**职责**：纯函数，入参 `PrimaryAgentRow | null`，出参 `WsSnapshot`。零副作用，不碰 bus。

```ts
import type { PrimaryAgentRow } from '../primary-agent/types.js';
import type { WsSnapshot } from './protocol.js';

/**
 * PrimaryAgentRow 直接透传。当 row 含未来新字段时，自动随 Row 扩张，
 * 不需要同步修改本模块。保持 snapshot = GET /api/primary-agent 的字段等价。
 */
export function buildPrimaryAgentSnapshot(row: PrimaryAgentRow | null): WsSnapshot {
  return { type: 'snapshot', primaryAgent: row };
}
```

**完成判据**：
- [ ] `ws/snapshot-builder.test.ts` 4 条：
  - null → `{type:'snapshot', primaryAgent:null}`
  - RUNNING row → 载荷 === 入参（referential equality 即可，避免无意义的深拷贝断言）
  - STOPPED row → 同上
  - 含 mcpConfig 非空数组的 row → 数组字段原样透传、不丢
- [ ] 文件 ≤ 25 行（实现行数）。

---

## Wave 2 · 业务胶水（依赖 W1）

### W2-0 · bus/types.ts 扩 `primary_agent.configured` payload 到全 Row（H2 方案 a）

**背景**：目前 `PrimaryAgentConfiguredEvent` 只带 `agentId / cliType / name`（见 `bus/types.ts:223-228`），但 snapshot 已统一到完整 Row。前端按 bus 事件 hydrate 时会出现"WS snapshot 和 configured 事件两路字段不对齐"，必须补齐。

**改动**：
1. `packages/backend/src/bus/types.ts` 改 `PrimaryAgentConfiguredEvent`：
   ```ts
   export interface PrimaryAgentConfiguredEvent extends BusEventBase {
     type: 'primary_agent.configured';
     agentId: string;     // = row.id，保留以兼容 visibility-filter 的 event.agentId 读取路径（见 filter/visibility-filter.ts:129）
     row: PrimaryAgentRow; // 新增：完整 Row，字段与 snapshot.primaryAgent 对齐
     // 旧字段 cliType / name 保留为 row.cliType / row.name，但依然直接放顶层一份供老消费方读：
     cliType: string;
     name: string;
   }
   ```
   > 为什么冗余保留 `cliType / name`：避免 `bus-integration.test.ts`、renderer WS bridge 等既有消费方一次性大改；未来可按需清理。
2. `packages/backend/src/primary-agent/primary-agent.ts:47-54` emit 处补传 `row: next`（`configure()` 已有 `next = upsertConfig(config)` 可直接用）。
3. `visibility-filter.ts:128` 里读取的是 `event.agentId`，**不变**。

**完成判据**：
- [ ] `bus/types.ts` 修改后 `PrimaryAgentConfiguredEvent` 含 `row: PrimaryAgentRow`
- [ ] `primary-agent.ts` emit 处补传 `row`，`primary-agent.test.ts` 既有断言（check `events[0].type==='primary_agent.configured'` 等）全绿
- [ ] 新增 1 条断言：emit 出来的 event.row 与 readRow() 后的结果 deep-equal
- [ ] `visibility-filter.test.ts`（若有）对 `primary_agent.configured` 事件的过滤仍绿（`event.agentId` 未动）
- [ ] 全仓 `tsc --noEmit` 绿

**依赖**：无（W2-0 与 W1 并行可做）。其他 W2 任务依赖 W2-0 完成后的新字段形状。

**非改动清单（红线）**：不动 `PrimaryAgentStartedEvent / PrimaryAgentStoppedEvent`（这两个事件本期不扩字段，前端靠 snapshot + configured 已够）；不动 `event-types.ts` 白名单。

---

### W2-A · ws-handler 路由 configure_primary_agent

**文件**：`packages/backend/src/ws/ws-handler.ts`

**改动**：
1. `WsHandlerDeps` 新增 `primaryAgent: { configure(config: PrimaryAgentConfig): Promise<PrimaryAgentRow> }`（只暴露 configure 一个方法，避免 handler 拿到全部主 Agent 能力）。
2. `routeUpstream` switch 增加 `'configure_primary_agent'` 分支 → `handleConfigure`。
3. `handleConfigure`：
   - 跨 user 校验：本期**不做**（后续接 per-user 时再加；用 TODO 注明）。
   - 构造 `PrimaryAgentConfig` → `await primaryAgent.configure(config)` → ack。
   - configure 内部会按 cliType 变更自动 stop/start → `primary_agent.started/stopped/configured` 事件走广播器正常推下去，前端按 bus 事件更新。
   - 失败：`sendError(ws, 'internal_error', msg)`。
   - **不 await driver ready**（与 prompt op 一致，立即 ack）。

**完成判据**：
- [ ] `ws/ws-handler.test.ts` 新增 4 条：
  - 合法 configure → ack + 真实 `PrimaryAgent.configure` 完成 + `primary_agent.configured` 事件在 bus 上出现
  - 合法 configure **立即 ack**（即使 configure 内部 stop/start 还没完成，ack 已经回）
  - cliType 未知（例如 `'bogus'`）→ 真实 configure 内部校验抛错 → `sendError('internal_error', ...)`
  - 不 await driver ready：用 never-ready 的 fake runtime，确认 ack 在 driver.start resolve 前已下推
- [ ] **不 mock primaryAgent**：测试里 `new PrimaryAgent(bus, new FakeRuntime())`（现成模式，见 `__tests__/primary-agent.test.ts:171` / `__tests__/codex-temp-files.test.ts:137`）+ `cliManager.snapshot.set('claude', {...}) / set('codex', {...})` 让 isAvailable 返回 true。这与项目 CLAUDE.md 的"不 mock 测试"红线一致。
- [ ] 不动现有 subscribe/unsubscribe/prompt/ping 路径。
- [ ] 文件 ≤ 200 行（目前 200，扩展后需要剥一个 `handleConfigure` 小函数；若仍超限把 configure 拆到新文件 `ws/handle-configure.ts`）。

**依赖**：W1-A。

---

### W2-B · ws-upgrade 连接建立时推快照

**文件**：`packages/backend/src/bus/ws-upgrade.ts`

**改动**：
1. `WsUpgradeDeps` 新增 `getPrimaryAgentRow: () => PrimaryAgentRow | null`。
2. `handleUpgrade` 回调里，在 `attachWsHandler` 调用**之后**、`ws.on('close')` 之前，调一次 `buildPrimaryAgentSnapshot(getPrimaryAgentRow()) → ws.send(JSON.stringify(...))`。
3. 发送时序：订阅表已建、broadcaster 已 addClient，保证 snapshot 不丢、之后的 event 流连得上。

**为什么放这里不放 ws-handler**：快照是"连接级一次性推送"，不属于上行消息路由；handler 只管 `on('message')`。放 upgrade 里更贴合生命周期语义。

**完成判据**：
- [ ] `bus/ws-upgrade.test.ts`（或就近新增）4 条：
  - 未配置 → 推 `{type:'snapshot', primaryAgent:null}`
  - 已配置 RUNNING → 推完整 Row 所有字段（含 mcpConfig / createdAt / updatedAt）
  - **首连竞态**：客户端一连上就立刻 `subscribe{global}`，后端必须先送 snapshot 再送 subscribe ack（保证前端 applySnapshot 在 hydrate 前完成）。断言序列：`ws.send` 第一次 arg 含 `"type":"snapshot"`，第二次才是 ack。
  - 推送失败（ws.send throw）吞掉，不 throw、不影响后续 close 回调注册
- [ ] 文件 ≤ 60 行（目前 47 行）。

**依赖**：W1-B。

---

### W2-C · http/server.ts 接线

**文件**：`packages/backend/src/http/server.ts`

**改动**：
1. 给 `attachWsUpgrade` 的 deps 传 `getPrimaryAgentRow: () => primaryAgent.getConfig()`。
2. 给 `handlerDeps` 追加 `primaryAgent: primaryAgent`。

**完成判据**：
- [ ] `bus-integration.test.ts` 回归：连接建立 → 收到 snapshot。
- [ ] tsc 绿。

**依赖**：W2-A + W2-B。

---

### W2-D · 前端对接文档（后端侧输出的是**契约**，不是前端代码）

> 本阶段**后端不改任何前端代码**（renderer 包不在本分工范围）。前端改造由前端团队按本节契约自行对接。

**后端要写/改的文档文件**：
- `docs/frontend-api/ws-protocol.md` — 新增两节：
  - **上行 §configure_primary_agent**：op 字面量、字段说明（cliType 必填非空；name/systemPrompt 可选；requestId 可选）、示例 JSON、下行 ack 形状、未知 cliType / CLI 不可用时的 error 形状。
  - **下行 §snapshot**：发送时机（"每次 WS 连接建立时推一次且仅一次"，在任何 event/ack 之前）、载荷 = 完整 PrimaryAgentRow（链回 primary-agent-api.md 的 types 小节）、未配置时 `primaryAgent:null`、载荷字段与 HTTP GET 1:1。
- `docs/frontend-api/primary-agent-api.md` — 顶部加横幅 `> **WARNING：前端已改走 WS，HTTP 仅供内部/调试，生产前端不要调用。**`，并加一节 §迁移对照：
  - `GET /api/primary-agent` → WS `snapshot`（建连即收）
  - `POST /api/primary-agent/config` → WS 上行 `configure_primary_agent`
  - `POST /api/primary-agent/start` → 前端废弃（应用启动自动拉起）；**后端端点保留供调试**
  - `POST /api/primary-agent/stop` → 前端废弃（应用退出自动停）；**后端端点保留供调试**
  - 并列一节 §本期 configure 能力边界：**只支持 `cliType/name/systemPrompt`**；`mcpConfig` **本期 WS 不暴露**（见下"未覆盖项"），需要改 mcpConfig 仍走 HTTP `POST /api/primary-agent/config`。
- `docs/frontend-api/INDEX.md` — `/api/primary-agent*` 4 行追加 `(内部/调试)` 字样；新增 `ws-protocol §configure_primary_agent` / `§snapshot` 的索引行。

**给前端团队的对接清单（文档里要列清楚）**：
1. 删掉对 `start` / `stop` / `GET` / `config` 4 个 HTTP 端点的调用（primaryAgentStore.actions.start/stop/refresh/configure）。
2. WS 客户端新增 `onSnapshot` 回调：收到 `{type:'snapshot'}` 时调用 `primaryAgentStore.applySnapshot(payload.primaryAgent)`。
3. `primaryAgentStore.configure(cli)` 改为发 WS 上行 `{op:'configure_primary_agent', cliType, requestId}`，等 ack；之后的 status 变化走现有 bus 事件路径（`primary_agent.*`）自然 hydrate。
4. 保留 `debouncedRefresh` 行为，但源从 HTTP GET 改为 applySnapshot（WS 断线重连时会再收到一次 snapshot）。

**完成判据**：
- [ ] `ws-protocol.md` 两节齐全，JSON 示例与守卫/builder 行为对齐。
- [ ] `primary-agent-api.md` 顶部 WARNING + §迁移对照 + §本期能力边界 三块齐全。
- [ ] `INDEX.md` 文案一致。
- [ ] 前端对接清单 4 条齐全、编号清晰，便于前端团队按条对齐。
- [ ] 不改 `packages/renderer/` 下任何源码（本阶段红线）。

**依赖**：W2-A + W2-B + W2-C（契约稳定后再写文档）。

---

### 未覆盖项（显式列出 · 不做）

| 项 | 不做的理由 | 后续路径 |
|---|---|---|
| `mcpConfig` 走 WS configure | 字段形状复杂（嵌套 `serverName/mode/tools?`），协议守卫需大量扩展；前端设置页目前也不在 WS 流里改它 | 继续走 HTTP `POST /api/primary-agent/config` |
| per-user snapshot 隔离 | 主 Agent 目前就是全局单例，所有连接看到同一份 | per-user 主 Agent 阶段再处理 |
| snapshot 带 turn / 对话历史 | turn 聚合器已有独立快照接口（`/api/instances/:id/turn`）+ gap-replay；不要重复一套 | 前端按既有链路 |
| 删除 HTTP 端点 | 向后兼容 + CLI/调试需要 | 二三个大版本后考虑 |

---

## Gate · 交付前自检

- [ ] `ws/protocol.ts` 单测全绿（含新增 6 条）
- [ ] `ws/snapshot-builder.ts` 单测全绿（含 mcpConfig 非空透传）
- [ ] `bus/types.ts` 改完 `PrimaryAgentConfiguredEvent.row` 字段 + `primary-agent.ts` emit 补 row，`primary-agent.test.ts` 全绿 + 新增 event.row === readRow() 断言
- [ ] `ws/ws-handler.ts` 单测全绿（含新增 4 条 · **不 mock PrimaryAgent**，走 FakeRuntime + cliManager.snapshot）
- [ ] `ws-upgrade` snapshot 推送回归绿（含首连竞态 + boot 静默跳过两场景）
- [ ] `bus-integration.test.ts` 绿（含"无 CLI 环境 snapshot 仍能推 null"）
- [ ] `visibility-filter` 对 `primary_agent.configured` 的过滤仍绿（agentId 字段未动）
- [ ] 全包 `tsc --noEmit` 绿
- [ ] `/api/primary-agent*` 4 个 HTTP 端点**未删、未改**（grep 对应 handler 仍在）
- [ ] 手动：起 Electron → 打开 DevTools → 连 WS → 收到 snapshot；切 CLI → 收到 ack → configured(含 row) → stopped → started
- [ ] 所有被改文件 ≤ 200 行

## 回归清单入口

见 [REGRESSION.md](./REGRESSION.md)。
