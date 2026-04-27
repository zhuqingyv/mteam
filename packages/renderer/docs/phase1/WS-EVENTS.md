# WS-EVENTS · 主 Agent 相关 WebSocket 事件对接表

> 仅列 Phase 1 主 Agent 场景会消费的事件。其他领域（team / comm / mcp / template / roster / container / notification）在 Phase 2+ 覆盖，本文档**不讨论**。
>
> 契约权威：`docs/frontend-api/ws-protocol.md`、`docs/frontend-api/turn-events.md`、`docs/frontend-api/primary-agent-api.md`、后端白名单 `packages/backend/src/ws/event-types.ts`。
>
> 已处理标记：✅ = 已对接并正确；⚠️ = 已对接但实现有 bug；❌ = 未对接。所有 ❌ / ⚠️ 对应 TASK-LIST.md 里具体一条。

---

## 0. 上行 op（前端→后端）

| op | 上行时机 | 处理代码 | 状态 |
|---|---|---|---|
| `subscribe` | useWsEvents mount 后 + instance scope（缺口 G6） | `api/ws.ts:81-86` / `useWsEvents.ts:28` | ⚠️ 只 subscribe global，缺 instance |
| `unsubscribe` | 切主 Agent（本期不涉及，单例） | `api/ws.ts:87-91` | ✅ 实现但未用 |
| `prompt` | ExpandedView.handleSend | `ExpandedView.tsx:80` | ✅ |
| `ping` | 30s 心跳 | `useWsEvents.ts:29` | ✅ |
| `configure_primary_agent` | 切 cliType（缺口 G12） | **未实现** | ❌ 现状走 HTTP |

---

## 1. WS 连接控制消息（下行）

### 1.1 `snapshot` · 每次建连推一次

**payload**:
```json
{ "type": "snapshot", "primaryAgent": PrimaryAgentRow | null }
```

**语义**: 连接建立后第一条消息（规定顺序先于 event/ack）。未配置时 `primaryAgent: null`。

**前端应做**: `primaryAgentStore.applySnapshot(primaryAgent)`：写 `config`、派生 `status` / `instanceId`、清 `lastError` / `driverLifecycle`。

**当前处理**: `api/ws.ts:47-55` 直接 `setState({ config, status, instanceId })`。

**状态**: ⚠️ 未清 `lastError` 与 `driverLifecycle`（缺口 G14）。

---

### 1.2 `gap-replay` · 断线重连补发

**payload**:
```json
{ "type": "gap-replay", "items": [{ "id": "evt_*", "event": {...} }], "upTo": "evt_*" | null }
```

**语义**: subscribe 带 `lastMsgId` 时，后端把 lastMsgId 之后的事件批量补回，保证序在实时 event 之前到达。

**前端应做**: 逐条 `onEv(event)`，同时更新 `lastMsgId = items[last].id`；`upTo=null` 表示无 gap。

**当前处理**: `api/ws.ts:60` 循环分发 + 写 lastMsgId。

**状态**: ✅ 消息分发正确。但**未调用** `getDriverTurns` 拉 Turn HTTP 快照（`turn-events.md` §5 规定断线重连先拉快照），见 G9。

---

### 1.3 `ack` · prompt / configure 收件确认

**payload**:
```json
{ "type": "ack", "requestId": "r1", "ok": true | false, "reason"?: "..." }
```

**前端应做**: `ok=false` 时提示用户（driver not ready 之类）；`ok=true` 仅做日志。configure 也会 ack，但真正结果走 `primary_agent.configured` 事件。

**当前处理**: `useWsEvents.ts` 只注册了 `onEvent`，**未注册** `onAck`。

**状态**: ❌ G13 补齐 `onAck` + 映射到 toast / lastError。

---

### 1.4 `error` · 连接级错误

**payload**:
```json
{ "type": "error", "code": "bad_request|not_found|forbidden|not_ready|internal_error", "message": "..." }
```

**前端应做**: 写 `primaryAgentStore.lastError` + UI toast。尤其 configure 抛错时只会走这里（不是 ack），用户必须看到。

**当前处理**: **未注册** `onError`。

**状态**: ❌ G13 补。

---

## 2. primary_agent.* 生命周期事件

后端 `bus/types.ts:213-231` 定义，白名单包含。全部在 global scope 广播。

### 2.1 `primary_agent.started`

**payload**:
```json
{ "type": "primary_agent.started", "agentId": "p_...", "cliType": "claude", "ts": "...", "eventId": "..." }
```

**语义**: driver 起来了（`primary-agent.ts:116`）。

**前端应做**: debouncedRefresh 让 store 拿到新 `status=RUNNING`。

**当前处理**: `wsEventHandlers.ts:10` → `primaryAgentBridge.onPrimaryAgentEvent` → debounced 150ms refresh。

**状态**: ✅

---

### 2.2 `primary_agent.stopped`

**payload**:
```json
{ "type": "primary_agent.stopped", "agentId": "p_...", "ts": "...", "eventId": "..." }
```

**语义**: driver 停了（stop / crash / handleDriverStopped）。

**前端应做**: debouncedRefresh，让 `status` 回到 STOPPED；若正在等待 turn 应清 streaming。

**当前处理**: 同 2.1。

**状态**: ✅（store 层）；⚠️（messageStore 里 active turn 未强制 complete，悬挂气泡风险，计入 G4）。

---

### 2.3 `primary_agent.configured`

**payload**:
```json
{ "type": "primary_agent.configured", "agentId": "...", "cliType": "codex", "name": "MTEAM",
  "row": PrimaryAgentRow, "ts": "...", "eventId": "..." }
```

**语义**: configure upsert 完成。payload 里带完整 `row`，等价 snapshot。

**前端应做**: 直接 `applySnapshot(row)` 最快；当前用 debouncedRefresh 也能收敛但多发一次 HTTP。

**当前处理**: 同 2.1。

**状态**: ✅（能工作，可优化）。

---

## 3. driver.* 生命周期（仅 3 类暴露给前端）

白名单只含 `started` / `stopped` / `error`。其余 `driver.thinking/text/tool_call/tool_result/turn_done` 已从白名单移除（`INDEX.md` §1.3 明确），前端改用 `turn.*`。

### 3.1 `driver.started`

**payload**:
```json
{ "type": "driver.started", "driverId": "p_...", "pid": 12345, "ts": "...", "eventId": "..." }
```

**前端应做**: 若 `driverId === primaryAgentStore.instanceId` → `driverLifecycle='ready'`。

**当前处理**: `wsEventHandlers.ts:13-16` → `primaryAgentBridge.onDriverEvent(kind, driverId)`。

**状态**: ✅

---

### 3.2 `driver.stopped`

**payload**:
```json
{ "type": "driver.stopped", "driverId": "p_...", "ts": "...", "eventId": "..." }
```

**前端应做**: `driverLifecycle='stopped'`；若有 active turn 清 streaming（见 G4）。

**当前处理**: 同 3.1（只写 lifecycle）。

**状态**: ⚠️ 未清 active turn。

---

### 3.3 `driver.error`

**payload**:
```json
{ "type": "driver.error", "driverId": "p_...", "message": "...", "ts": "...", "eventId": "..." }
```

**前端应做**: `driverLifecycle='error'` + `lastError=message` + toast。

**当前处理**: 只映射到 `driverLifecycle='error'`，**未**写 `lastError`。

**状态**: ⚠️ 完善为同时写 lastError（G13 一并处理）。

---

## 4. turn.* Turn 聚合事件（核心流式通道）

白名单 `event-types.ts:42-45` 全部包含。**主 Agent 的实际对话内容全部走这里**，不是 driver.* 那些原始事件。

### 4.1 `turn.started`

**payload**:
```json
{
  "type": "turn.started",
  "driverId": "p_...",
  "turnId": "turn_...",
  "userInput": { "text": "...", "attachments": [], "ts": "..." },
  "ts": "...", "eventId": "..."
}
```

**语义**: 新 turn 开始（`turn-events.ts:15-20`）。前端看到它就该把 agent 气壳先画出来、亮「思考中」。

**前端应做**:
```typescript
if (driverId !== primaryAgentStore.instanceId) return;
addMessage({ id: turnId, role:'agent', turnId, streaming: true, blocks: [], content: '', time: fmt(userInput.ts) });
```

**当前处理**: ❌ `wsEventHandlers.ts:40` 直接 `if (t !== 'turn.block_updated') return;` —— 被吞。

**状态**: ❌ G1。

---

### 4.2 `turn.block_updated`

**payload**:
```json
{
  "type": "turn.block_updated",
  "driverId": "p_...", "turnId": "...", "seq": 2,
  "block": TurnBlock,   // 完整最新状态，见 turn-events.md §1
  "ts": "...", "eventId": "..."
}
```

**语义**: block 按 `blockId` upsert；内容是 **完整最新状态（非 delta）**。9 种 block type：thinking / text / tool_call / plan / usage / commands / mode / config / session_info。前 5 种 scope='turn'（挂当前 turn 气泡）；后 4 种 scope='session'（挂顶栏/设置组件，Phase 1 可先忽略）。

**前端应做**:
```typescript
if (driverId !== pa.instanceId) return;
const t = block.type;
if (['thinking','text','tool_call','plan','usage'].includes(t)) {
  messageStore.updateTurnBlock(turnId, block);          // blockId upsert
  if (t === 'text')     mirrorContent(turnId, block);   // 扁平 content 供 MessageRow 快速读
  if (t === 'thinking') mirrorThinking(turnId, true);
}
// scope='session' 的 4 种 block 分发到 sessionBlocksStore（Phase 1 可 stub）
```

**当前处理**: ⚠️ 只认 `type='text'`；且把 `block.content` **当 delta 累加**（`wsEventHandlers.ts:47-49`），错。`turn-events.md` §2.2 / §7 反复强调 block 是"完整最新状态，永远覆盖，不追加"。

**状态**: ⚠️ G2（扩 type）+ G3（覆盖不累加，最严重 bug）。

---

### 4.3 `turn.completed`

**payload**:
```json
{
  "type": "turn.completed",
  "driverId": "p_...", "turnId": "...",
  "turn": Turn,   // 完整成交，含 blocks / usage / stopReason / endTs
  "ts": "...", "eventId": "..."
}
```

**前端应做**:
```typescript
messageStore.completeTurn(turnId);   // streaming=false
if (turn.usage) uiStore.setUsage(turn.usage);
```

**当前处理**: ❌ 被 `handleTurnEvent` 的 `return` 吞。

**状态**: ❌ G4。

---

### 4.4 `turn.error`

**payload**:
```json
{ "type": "turn.error", "driverId": "...", "turnId": "...", "message": "...", "ts": "...", "eventId": "..." }
```

**语义**: 与 `turn.completed{status:'error'}` 同时发。

**前端应做**: `completeTurn(turnId)` + `lastError = message` + toast。

**当前处理**: ❌ 被吞。

**状态**: ❌ G5。

---

## 5. 事件处理优先级与竞态

### 5.1 事件顺序保证（后端侧）

| 场景 | 保证 |
|---|---|
| 建连 | snapshot **先** 于任何 event / ack |
| subscribe 带 lastMsgId | gap-replay **先** 于 ack、**先** 于后续实时 event |
| prompt 发出 | ack 不保证在 driver.* 之前；两条通道独立 |
| turn 生命周期 | 同一 turnId 下 `turn.started` < `turn.block_updated` * N < `turn.completed/error` |

### 5.2 前端应处理的竞态

| 竞态 | 现象 | 缓解 |
|---|---|---|
| primary_agent.configured 紧跟 primary_agent.stopped+started（切 cliType） | 3 个事件 100ms 内抵达 | 150ms debouncedRefresh 合并为一次 HTTP GET |
| `driver.started` 早于 `primary_agent.started` 到达 | `instanceId == null` 时收到 driver 事件 | `primaryAgentBridge.onDriverEvent` 在 instanceId 为空时补一次 refresh |
| 用户快速切 cliType 期间有 turn 在跑 | turn.* 来自旧 driver | Phase 1 不处理：configure 触发 stop 会发 driver.stopped，前端清 streaming（依赖 G4） |
| WS 断线期间发生多轮 turn | gap-replay 批量补发 turn.* | 前端按 blockId/turnId upsert 天然幂等；但 `turn.started` 没到时 addMessage 找不到 turnId 的气壳 → 需先 `getDriverTurns` 拉快照建壳（G9） |

---

## 6. 订阅策略

| scope | id | 何时订 | Phase 1 状态 |
|---|---|---|---|
| `global` | — | useWsEvents mount | ✅ 已订 |
| `instance` | primaryAgent.id | 拿到 `instanceId` 且 `!= null` 后；主 Agent id 切换（理论不会发生）时 unsub 旧 + sub 新 | ❌ 未订（G6） |
| `team` | teamId | Phase 3 | n/a |
| `user` | userId | Phase 4 通知 | n/a |

> 后端目前仍按 global 广播 turn.* 能收到；但按 `ws-protocol.md` §subscribe 语义，turn.* 的"设计接收位"是 instance scope。一旦后端收紧过滤前端就瞎。**必须**在 Phase 1 补 instance 订阅（G6），否则技术债留隐患。

---

## 7. 速查：一轮对话的事件流（正确路径）

```
用户发送 "帮我 X"
  ├─ 前端 ExpandedView.handleSend → ws.prompt(instanceId, 'X', reqId)
  ├─ 前端 addMessage({ id:'u-...', role:'user', content:'X' })
  └─ WS 下行流：
        { type:'ack', requestId:reqId, ok:true }                        → 忽略或日志
        { type:'event', event:{ type:'turn.started', turnId:'t1', userInput:{...} } }
          → messageStore.addMessage({ id:'t1', role:'agent', turnId:'t1', streaming:true, blocks:[] })
        { type:'event', event:{ type:'turn.block_updated', turnId:'t1', block:{ blockId:'b1', type:'thinking', content:'...' } } }
          → updateTurnBlock('t1', block) + thinking=true
        { type:'event', event:{ type:'turn.block_updated', turnId:'t1', block:{ blockId:'b2', type:'text', content:'hello' } } }
          → updateTurnBlock('t1', block) ; content 取代为 'hello'
        { type:'event', event:{ type:'turn.block_updated', turnId:'t1', block:{ blockId:'b2', type:'text', content:'hello world' } } }
          → content 取代为 'hello world'（覆盖，不是累加）
        { type:'event', event:{ type:'turn.completed', turnId:'t1', turn:{ ...usage } } }
          → completeTurn('t1')
```

现状会错在：

1. `turn.started` 被吞 → agent 气泡在第一个 block 才出现（体验烂）。
2. `block.type` 非 text 被吞 → thinking 不显示。
3. 上面「content 取代为 hello world」→ 实际变成 `hello + hello world` = `hellohello world`，每 block 越来越长。
4. `turn.completed` 被吞 → `streaming` 一直 true、usage 丢。
