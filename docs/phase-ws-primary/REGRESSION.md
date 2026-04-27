# Phase WS-Primary · REGRESSION

> 所有新增行为必须拿测试钉死，旧行为必须拿测试证明没被撬动。每条列出"前提 / 步骤 / 期望 / 证据落点"。

## R1 · 协议层（Wave 1）

### R1-1 合法 configure_primary_agent 通过守卫
- 前提：`isWsUpstream`
- 入参：`{op:'configure_primary_agent', cliType:'codex'}` / 带 `name` / 带 `systemPrompt` / 带 `requestId`
- 期望：全部返回 true
- 证据落点：`ws/protocol.test.ts`

### R1-2 非法 configure_primary_agent 被拒
- 入参：
  - `{op:'configure_primary_agent'}` 缺 cliType
  - `{op:'configure_primary_agent', cliType:''}` 空串
  - `{op:'configure_primary_agent', cliType:'codex', unknownField:1}` 多余字段
  - `{op:'configure_primary_agent', cliType:123}` 类型错
- 期望：全部返回 false
- 证据落点：`ws/protocol.test.ts`

### R1-3 现有 op 守卫不回归
- 期望：subscribe/unsubscribe/prompt/ping 原有用例全绿，未新增也未删减
- 证据落点：`ws/protocol.test.ts` 原用例

### R1-4 snapshot builder 纯函数
- 入参 null → `{type:'snapshot', primaryAgent:null}`
- 入参 `{id:'p1', status:'RUNNING', name:'MTEAM', cliType:'claude', ...}` → 字段 1:1 投影，无多余字段泄漏
- 证据落点：`ws/snapshot-builder.test.ts`

---

## R2 · ws-handler（Wave 2）

> **测试红线**：本组全部用例**禁止 mock PrimaryAgent**。用真实 `new PrimaryAgent(bus, new FakeRuntime())` + `cliManager.snapshot.set('claude', {...}) / set('codex', {...})`（见 `__tests__/primary-agent.test.ts:171` / `__tests__/codex-temp-files.test.ts:137` 现成模式）。验证真实行为（DB upsert + 事件 emit + driver 重启），不是假行为的调用次数。

### R2-1 合法 configure 触发真实 primaryAgent.configure 且立即 ack
- 前提：
  - `new PrimaryAgent(bus, fakeRuntime)` + `cliManager.snapshot` 预置 claude/codex；先 `configure({cliType:'claude'})+start()` 让其 RUNNING
  - attachWsHandler 注入 `{op:'configure_primary_agent', cliType:'codex', requestId:'r1'}`
- 期望：
  - bus 上在"合理时间内"出现 `primary_agent.configured` + `primary_agent.stopped` + `primary_agent.started` 三事件（切 cliType 的真实链路）
  - ws.send 第一帧在真实 configure() resolve 之前就发出 `{type:'ack', requestId:'r1', ok:true}`
- 证据落点：`ws/ws-handler.test.ts`
- **关键契约**：不 await primaryAgent.configure(). 用 `FakeRuntime.spawn` 故意延迟 resolve（例如 500ms）以拉长 stop/start 窗口，断言 ack 时序先于 driver.start.resolve。

### R2-2 cliType 非法时真实 configure 链路抛错 → error 下行
- 前提：
  - 已 `configure({cliType:'claude'}) + start()` 让其 RUNNING（cliChanged=true 的前提）
  - `cliManager.snapshot` 里不注入 `bogus`
  - 发 `{op:'configure_primary_agent', cliType:'bogus'}`
- 真实链路：`primary-agent.ts:46-62` configure → upsert+emit 成功 → cliChanged=true → `await stop()` → `await start()` → `start()` 内 `cliManager.isAvailable('bogus')===false` → `throw new Error("cli 'bogus' is not available")`（见 `primary-agent.ts:73-75`）
- 期望：
  - 下行一条 `{type:'error', code:'internal_error', message: 含 'bogus' + 'not available'}`
  - 老的 driver 已被 stop()（`primary_agent.stopped` 先 emit 过）
  - DB 里 row.cliType 已变为 'bogus'（configure 不回滚）— 前端会通过下一个 snapshot/重连看到 STOPPED 状态
- 证据落点：`ws/ws-handler.test.ts`
- **不 mock**：走 `cliManager.isAvailable('bogus')===false` 的真实分支（见 `primary-agent.ts:73`）。注意 error 在 start() 抛，不在 configure() 入口抛 — 这是真实代码路径，不是设计缺陷。

### R2-3 带 name / systemPrompt 的 configure 字段真实透传到 DB
- 前提：发 `{op:'configure_primary_agent', cliType:'claude', name:'X', systemPrompt:'Y'}`
- 期望：
  - ws 下行 ack.ok=true
  - 用 `primaryAgent.getConfig()` 读 row，`name==='X'` 且 `systemPrompt==='Y'`（真实 SQLite 落盘）
  - 非传入字段（mcpConfig）未被清空（保持 upsert 不是 replace 的语义）
- 证据落点：`ws/ws-handler.test.ts`
- **不 mock**：直接查真实 `readRow()` 的返回。

### R2-4 subscribe/unsubscribe/prompt/ping 路径不回归
- 期望：原 ws-handler 用例全绿，ack/error/gap-replay 时序不变
- 证据落点：`ws/ws-handler.test.ts` 原用例

---

## R3 · ws-upgrade 快照推送（Wave 2）

### R3-1 未配置 → 推 snapshot null
- 前提：getPrimaryAgentRow 返回 null；模拟 upgrade
- 期望：新连接上**第一条**下行 = `{type:'snapshot', primaryAgent:null}`
- 证据落点：`bus/ws-upgrade.test.ts`（或新增 `ws-upgrade-snapshot.test.ts`）

### R3-2 已配置 RUNNING → 推完整 Row
- 前提：getPrimaryAgentRow 返回一个真实 `PrimaryAgentRow`，字段齐（id/name/cliType/systemPrompt/mcpConfig=[]/status=RUNNING/createdAt/updatedAt）
- 期望：第一条 = `{type:'snapshot', primaryAgent: <完整 Row>}`，字段逐个相等，**不能收窄为子集**
- 证据落点：同上

### R3-3 Row 含非空 mcpConfig 时原样透传
- 前提：row.mcpConfig = `[{serverName:'fs', mode:'whitelist', tools:['read']}]`
- 期望：snapshot.primaryAgent.mcpConfig 与入参 deep-equal
- 证据落点：同上

### R3-4 快照在订阅表建完之后发
- 前提：同 R3-2，且订阅 subscriptionManager.addConn 先调用
- 期望：spy 顺序 → `addConn → addClient → attachWsHandler → ws.send(snapshot)`
- 证据落点：同上

### R3-5 首连竞态：client 一连上就 subscribe，snapshot 先于 ack
- 前提：client 在建连后立刻推 `{op:'subscribe', scope:'global'}`
- 期望：ws.send 调用序列里 snapshot 那帧的下标 < subscribe ack 那帧的下标（保证前端 applySnapshot 在 hydrate 其他数据前完成）
- 证据落点：`bus/ws-upgrade.test.ts` 或新增 `ws-upgrade-snapshot.test.ts`

### R3-6 snapshot 发送失败吞掉不 throw
- 前提：ws.send 抛错
- 期望：不 throw，后续 close 回调仍被正确注册
- 证据落点：同上

---

## R4 · 集成（Wave 2 接线后）

### R4-1 真实 WS 连接收到 snapshot
- 前提：起后端 + primaryAgent.boot 拉起 claude
- 步骤：WS client 连上 `/ws/events` → 等第一帧
- 期望：收到 `{type:'snapshot', primaryAgent:{status:'RUNNING',...}}`
- 证据落点：`__tests__/bus-integration.test.ts` 新增用例

### R4-2 configure 切 CLI → stopped/configured/started 三连
- 前提：同 R4-1，当前 claude RUNNING
- 步骤：上行 `{op:'configure_primary_agent', cliType:'codex'}`
- 期望（按 bus emit 顺序）：
  - ack（立即）
  - `primary_agent.configured`（事件下行）
  - `primary_agent.stopped`（老 driver）
  - `primary_agent.started`（新 driver）
- 证据落点：`__tests__/bus-integration.test.ts` 或 `http-primary-agent.test.ts` 新增

### R4-3 不切 cliType 的 configure 不重启
- 步骤：当前 codex，上行 `{op:'configure_primary_agent', cliType:'codex', name:'X2'}`
- 期望：ack + 只有 `primary_agent.configured`，无 stopped/started
- 证据落点：同 R4-2

---

## R5 · 应用生命周期（回归，非本期新增）

> 这些行为已经存在，本期不修改；列出来是防止接线时被误伤。

### R5-1 应用启动自动拉起主 Agent
- 证据：`http/server.ts:120 primaryAgent.boot()` 调用存在
- 测试落点：已有 `primary-agent.test.ts` 覆盖 boot 路径

### R5-2 应用退出自动停主 Agent
- 证据：`http/server.ts:143 primaryAgent.teardown()` 在 shutdown 钩子里
- 测试落点：已有 `http-primary-agent.test.ts` 或 `primary-agent.test.ts` 覆盖 teardown

### R5-3 HTTP start/stop/config/GET **前端废弃，后端保留供调试**
- 证据：`api/panel/primary-agent.ts` 四个 handler 未删、路由未下线
- 期望：现有 `http-primary-agent.test.ts` 用例全绿；后端行为相对本分支前零变更

### R5-4 boot 静默跳过的已知场景（不得回归）
- 场景 A：`readRow()` 为 null 且 `cliManager` 里 claude/codex 均不可用 → stderr `no CLI available, skip auto-configure`，不抛错、不改 DB、不 emit 事件
- 场景 B：`readRow()` 存在但 `cliManager.isAvailable(row.cliType)` 为 false → stderr `cli '<x>' unavailable, skip auto-start`，status 若为 RUNNING 被强制纠成 STOPPED（`primary-agent.ts:28`）
- 期望：此时 WS 建连仍发 snapshot（场景 A primaryAgent 为 null；场景 B primaryAgent 含 STOPPED row），前端按 status 渲染离线态即可
- 证据落点：`__tests__/primary-agent.test.ts` 已有 boot 行为用例；`bus-integration.test.ts` 新增"无 CLI 环境下 WS 建连仍能收到 snapshot(null)"

---

## R6 · 文档一致性（非代码）

### R6-1 ws-protocol.md 含新 op + snapshot 示例
- 证据：grep `configure_primary_agent` 命中一次以上；grep `"type": "snapshot"` 命中一次以上

### R6-2 primary-agent-api.md 顶部有 WARNING
- 证据：文档首屏含 `> **WARNING** ... 前端不要调用` 字样

### R6-3 INDEX.md 对应 4 行标"(内部/调试)"
- 证据：`grep -c '内部/调试' docs/frontend-api/INDEX.md >= 4`

### R6-4 primary-agent-api.md 显式声明 mcpConfig 本期不走 WS configure
- 证据：文档新加的"本期能力边界"节里，grep `mcpConfig.*不暴露` 或 `mcpConfig.*仍走 HTTP` 命中 1 次以上
- 期望：前端按文档只在 WS configure 里传 cliType/name/systemPrompt，改 mcpConfig 仍走 `POST /api/primary-agent/config`，不会因为协议文档遗漏而误以为 WS 已接管全部字段

### R6-5 ws-protocol.md 不出现 status='ERROR'
- 证据：`grep -c "ERROR" docs/frontend-api/ws-protocol.md`（在 snapshot 章节内）= 0
- 期望：协议 status 只允许 `'STOPPED' | 'RUNNING'`，禁止传染到前端

---

## R7 · 前端对接回归（前端团队拿这组验收）

> 本组不在后端测试矩阵内，但写在这里作为**契约底线**，前端团队按本节自查后回告。后端侧通过 `docs/frontend-api/primary-agent-api.md §前端对接清单` 链回本节。

### R7-1 删除主 Agent HTTP 调用（前端代码清理）
- 目标文件：`packages/renderer/src/stores/primaryAgentStore.ts` 及相关 hooks
- 期望：全仓 `grep -n '/api/primary-agent'` 在 renderer 包内**命中 0 次**
- 废弃的 4 个入口：`GET /api/primary-agent` / `POST /config` / `POST /start` / `POST /stop`（**注**：后端 HTTP 不删，供内部/调试调用；仅前端废弃这 4 个入口）

### R7-2 primaryAgentStore 接入 snapshot
- 目标：store 暴露 `applySnapshot(row: PrimaryAgentRow | null): void`
- WS 客户端收到下行 `{type:'snapshot'}` 时调用一次
- 期望：首次建连后 store.config 就是 snapshot.primaryAgent；`selectOnline = RUNNING && instanceId != null` 行为保留（见 mnemo #517）

### R7-3 configure 改发 WS 上行
- 目标：`primaryAgentStore.configure(cli)` 不再发 HTTP，改发 `{op:'configure_primary_agent', cliType, requestId}`
- 期望：
  - 发出后 `inflightAction` 立即设 'configure'，ack 回来后清
  - 状态变化不靠 ack 也不靠 HTTP 结果，全靠 `primary_agent.configured / stopped / started` 三个 bus 事件 + 下一次 snapshot（断线重连时）
  - **重要**：`primary_agent.configured` 事件 payload 已按 W2-0 扩到含 `row` 字段，前端 bridge 可直接 `applySnapshot(event.row)` 避免再补一次 HTTP refresh

### R7-4 断线重连仍然对齐状态
- 期望：WS 断开 → 重连后第一帧仍是 snapshot（后端 ws-upgrade 每连必发），store 据此覆盖旧 state；不再需要 `debouncedRefresh` 走 HTTP

### R7-5 手动验收单（前端团队跑）
- [ ] 打开应用 → DevTools Network → 搜 `primary-agent` 应该只在 bootstrap 以外**找不到任何 HTTP 请求**
- [ ] WS Network 面板 → 第一条帧是 `{"type":"snapshot",...}`
- [ ] 设置页切 CLI → WS 依次收到 `ack → primary_agent.configured (含 row) → primary_agent.stopped → primary_agent.started`
- [ ] 杀后端进程再起 → 前端自动重连 → 再次收到 snapshot，store 状态刷新正确

---

## 手动验收清单（交付前必跑）

- [ ] Electron 启动 → 日志看到 `[primary-agent] boot: auto-...`
- [ ] DevTools Network WS → 第一帧是 `snapshot`
- [ ] 设置页切 CLI → WS 连续收到 `configured → stopped → started`
- [ ] 关闭窗口 → 日志看到 `primary-agent teardown`
- [ ] 重开应用 → 第一帧 snapshot 字段正确

## 不在本期范围

- per-user 主 Agent 隔离（snapshot 目前按 global 推，所有连接看到同一个）
- 快照里带 driver 当前 turn / 对话历史（本期只是配置 + status）
- configure 失败后的前端重试策略（前端自己决定）
- 删除 HTTP 端点（本期统一口径：**前端废弃，后端保留供调试**，不移除）
