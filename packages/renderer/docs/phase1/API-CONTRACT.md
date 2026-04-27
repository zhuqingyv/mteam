# API-CONTRACT · 前端 ↔ 后端接口契约（Phase 1 主 Agent 范围）

> **前端红线（记忆 #no_direct_backend_api）**: 只走 `/api/panel/*` 门面层。本文档列的所有 HTTP 端点都是前端可以调的白名单，不在这里的一律禁调。
>
> 契约权威: `docs/frontend-api/INDEX.md` §2.9、`primary-agent-api.md`、`turn-events.md` §4、`ws-protocol.md`。
>
> **重要**：按 `primary-agent-api.md` 的迁移对照，HTTP `POST /config` / `/start` / `/stop` 前端**改走 WS** 或由应用生命周期自动处理。HTTP 仅保留为内部/调试入口，Phase 1 代码里对应 fetch 需要清理（缺口 G11 / G12）。

---

## 1. HTTP · 前端白名单（Phase 1）

全部请求走 `panelGet` / `panelPost`（`src/api/client.ts`），base URL 由 Electron 环境注入；失败返回 `ApiResult<T> = { ok:false, error:string } | { ok:true, data:T }`。

### 1.1 `GET /api/panel/primary-agent`

**用途**：读当前主 Agent 配置。Phase 1 仅用作 bootstrap / debouncedRefresh 兜底；正常流程靠 WS snapshot + configured 事件。

**请求**: 无 body、无 query。

**响应 200**: `PrimaryAgentRow | null` —— 未配置时 `null`（不是 404）。

**响应 5xx**: `{ error: string }`。

**前端封装**: `src/api/primaryAgent.ts:29` `getPrimaryAgent()`。

---

### 1.2 `POST /api/panel/primary-agent/config` ⚠️ Phase 1 应迁移到 WS

**用途**：upsert 主 Agent 配置。首次调用自动生成 `id`；之后只传需要改的字段。切 cliType 若正在 RUNNING，后端会自动 stop → start。

**请求 body**:
```json
{
  "name": "Leader",
  "cliType": "claude",
  "systemPrompt": "...",
  "mcpConfig": [{ "serverName": "mteam", "mode": "all" }]
}
```
全部字段可选（增量 upsert）。约束：`name` 1~64；`cliType` 非空；`mcpConfig` 每项 `serverName` 非空、`mode` ∈ {all, whitelist}，whitelist 需带 `tools: string[]`。

**响应 200**: `PrimaryAgentRow`。

**响应 400**: 任一字段违反约束。

**前端封装**: `configurePrimaryAgent(body)`。

**迁移**（G12）: `cliType / name / systemPrompt` 场景改为 WS `configure_primary_agent`；只有修改 `mcpConfig` 仍走 HTTP（WS 本期不暴露 mcpConfig，避免 schema 复杂度）。

---

### 1.3 `POST /api/panel/primary-agent/start` ⚠️ 前端应删

**用途**：启动主 Agent driver。

**迁移**: 应用启动时后端 `http/server.ts` 自动 `primaryAgent.boot()`（记忆 #528），前端**不调**。Phase 1 任务 G11 把 `primaryAgentStore.start` + API 函数一起删。

---

### 1.4 `POST /api/panel/primary-agent/stop` ⚠️ 前端应删

**用途**：停 driver。

**迁移**: Electron before-quit / window-all-closed 已挂 `stopBackend`（记忆 #528）。前端**不调**。Phase 1 任务 G11 删除。

---

### 1.5 `GET /api/panel/cli`

**用途**：读 CLI 扫描快照（不触发扫描）。展开态 ToolBar 的 cliType 下拉数据源。

**响应 200**: `CliInfo[]` —— `{ name, path, version|null, available }`（字段详见 `templates-and-mcp.md`）。

**前端封装**: `src/api/cli.ts` `listCli()`。

**调用时机**: ExpandedView mount（现状如此）。

---

### 1.6 `GET /api/panel/driver/:driverId/turns?limit=10`

**用途**：拉某 driver 的 `{ active, recent }` turn 快照。**断线重连必用**（G9）；初次打开展开态也建议先拉一次恢复历史。

**query**: `limit` 可选，默认 10，上限 50。

**响应 200**:
```json
{
  "active": Turn | null,    // 当前进行中 turn；从未跑过 / 无活跃都是 null（不 404）
  "recent": Turn[]          // 已结束，按 endTs 降序
}
```

**Turn 结构**: 见 `turn-events.md` §1 / `src/api/driver-turns.ts:9-48`。

**前端封装**: `getDriverTurns(driverId, limit?)`。

**调用时机**（Phase 1）：
- WS 重连后、subscribe instance 之前
- 展开态首次挂载（可选优化）

---

## 2. WebSocket · 前端唯一入口

**连接 URL**: `ws://<host>:<port>/ws/events?userId=local`。断线自动重连，间隔 3s（`api/ws.ts:65`）。

### 2.1 上行 op

#### `subscribe`

**payload**:
```json
{ "op":"subscribe", "scope":"global"|"team"|"instance"|"user", "id"?:"...", "lastMsgId"?:"..." }
```

- `global`: `id` 可省；订所有广播事件
- `instance`: `id = primaryAgent.id`（Phase 1 主 Agent 用）
- `team`: Phase 3
- `user`: Phase 4（`id` 必须 === 建连 `userId`）
- `lastMsgId`: 断线重连带上最后收到的 eventId，后端会先推 `gap-replay` 再推 `ack`

**封装**: `wsClient.subscribe(scope, id?)`（内部自动带 `lastMsgId`）。

**Phase 1 调用**:
- mount: `subscribe('global')` ✅
- 拿到 `instanceId` 后: `subscribe('instance', instanceId)` ❌（G6）

---

#### `unsubscribe`

**payload**: `{ "op":"unsubscribe", "scope", "id"? }`

Phase 1 不使用（单主 Agent，不会切）。

---

#### `prompt`

**payload**:
```json
{ "op":"prompt", "instanceId":"p_...", "text":"...", "requestId"?:"req_1" }
```

**语义**: fire-and-forget，发消息给指定 instance（主 Agent 用 `primaryAgent.id`）。

**后端行为**: 立刻落库 + emit `comm.message_sent` + 推给 driver stdin → 产出 turn.*。

**响应**: WS 下行 `ack{requestId, ok:true}`；驱动未就绪时 `ack{ok:false, reason:'driver not ready'}` 或 `error{code:'not_ready'}`。

**封装**: `wsClient.prompt(instanceId, text, requestId?)`。

---

#### `ping`

**payload**: `{ "op":"ping" }`

**响应**: `{ "type":"pong", "ts":"ISO" }`

**Phase 1**: 30s 心跳（`useWsEvents.ts:29`）。

---

#### `configure_primary_agent`

**payload**:
```json
{ "op":"configure_primary_agent", "cliType":"codex", "name"?:"...", "systemPrompt"?:"...", "requestId"?:"r" }
```

**能力边界**（本期 WS 不支持 `mcpConfig`，改 mcpConfig 必须走 HTTP）：
- `cliType` 必填、非空字符串
- `name` / `systemPrompt` 可选
- 任何额外字段返回 `error{code:'bad_request'}`

**时序**:
1. 后端立即回 `ack{ok:true}` —— 不等 configure 内部 stop/start 跑完
2. configure 完成 → `primary_agent.configured{row}` 事件
3. 切 cliType → 多一次 `primary_agent.stopped` 再 `primary_agent.started`
4. configure / start 失败 → `error{code:'internal_error', message:e.message}`

**Phase 1 任务 G12**: 在 `api/ws.ts` 增 `wsClient.configurePrimaryAgent(cliType, name?, systemPrompt?, requestId?)`，`primaryAgentStore.configure` 优先走这个。

---

### 2.2 下行消息（type 分派）

详见 [WS-EVENTS.md](./WS-EVENTS.md) 第 1/2/3/4 节。本表只做速查。

| type | 来源 | 前端路由 | Phase 1 状态 |
|---|---|---|---|
| `snapshot` | 建连一次 | `api/ws.ts` setState | ⚠️ G14（未清 lastError） |
| `event` (primary_agent.*) | bus 实时 | `primaryAgentBridge.onPrimaryAgentEvent` | ✅ |
| `event` (driver.started/stopped/error) | bus 实时 | `primaryAgentBridge.onDriverEvent` | ⚠️ error 未写 lastError |
| `event` (turn.started) | bus 实时 | `handleTurnEvent` | ❌ G1 |
| `event` (turn.block_updated) | bus 实时 | `handleTurnEvent` | ⚠️ G2+G3 |
| `event` (turn.completed) | bus 实时 | `handleTurnEvent` | ❌ G4 |
| `event` (turn.error) | bus 实时 | `handleTurnEvent` | ❌ G5 |
| `gap-replay` | subscribe 带 lastMsgId 后 | `api/ws.ts` 展开分发 | ✅ 基础；⚠️ 未先拉 HTTP 快照（G9） |
| `ack` | prompt / configure / subscribe | 应 toast 失败 / log 成功 | ❌ 未注册 onAck（G13） |
| `pong` | ping 回复 | 无需 | ✅ |
| `error` | 协议错 / internal_error | `lastError` + toast | ❌ 未注册 onError（G13） |

---

### 2.3 错误码映射表

| code | 触发 | 前端处理 |
|---|---|---|
| `bad_request` | JSON/schema 错 / 多字段 | 日志；正常代码不会触发 |
| `not_found` | subscribe 目标不存在 | 日志 + 忽略；可能是主 Agent 未配置 |
| `forbidden` | user scope 订别人 / 跨 user prompt | 不应出现，代码 bug |
| `not_ready` | prompt 时 driver 未 READY | toast "主 Agent 未就绪，请稍候"；不清输入框 |
| `internal_error` | configure 失败 / 广播失败 | `lastError = message` + toast |

---

## 3. ApiResult 与错误处理

全部 HTTP 封装返回：

```typescript
type ApiResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: string; status?: number };
```

**规则**：
- 2xx + JSON 解析成功 → `ok: true`
- 其他一律 `ok: false`，`error` 优先取 body `{ error: string }`，否则 statusText
- 调用方**必须**判 `ok`，不判即视为 bug
- 不 throw，避免组件层到处 try/catch

---

## 4. 跨层调用时序（Phase 1 完整场景）

### 4.1 冷启动

```
App mount
  ├─ useBootstrap
  │    └─ primaryAgentStore.refresh()  → GET /api/panel/primary-agent  → setState
  └─ useWsEvents
       └─ createWsClient
            ├─ onopen → flush pending (空)
            ├─ 收 snapshot → setState(config, status, instanceId)
            └─ ws.subscribe('global')
                 └─ 收 ack
```

Phase 1 完成后还应叠加：

```
拿到 instanceId !== null 时：
  └─ ws.subscribe('instance', instanceId)   ← G6
  └─ getDriverTurns(instanceId)             ← G9（可选，用作初始历史）
```

### 4.2 用户发送

```
ExpandedView.handleSend
  ├─ 本地 addMessage(userMsg)
  └─ ws.prompt(instanceId, text, reqId)
        ├─ 收 ack{requestId:reqId, ok:true}                 → （未来）reqId map 标已发
        ├─ 收 event{turn.started}                           → addMessage(agent 空壳)
        ├─ 收 event{turn.block_updated[thinking]}           → updateTurnBlock
        ├─ 收 event{turn.block_updated[text]} × N           → updateTurnBlock（覆盖，非累加）
        └─ 收 event{turn.completed}                         → completeTurn
```

### 4.3 切 cliType（WS 路径）

```
ModelDropdown onChange
  └─ primaryAgentStore.configure({ cliType: 'codex' })
        ├─ inflightAction = 'configure'
        ├─ ws.configurePrimaryAgent('codex', undefined, undefined, reqId)   ← G12
        ├─ 收 ack{ok:true}                                                  → 不清 inflight（等事件）
        ├─ 收 event{primary_agent.configured{row}}                          → debouncedRefresh → config 更新
        ├─ 收 event{primary_agent.stopped}                                  → status=STOPPED
        ├─ 收 event{primary_agent.started}                                  → status=RUNNING
        └─ 最终 refresh 清 inflightAction（ finally）
```

### 4.4 断线重连

```
ws.onclose  → 3s setTimeout → connect()
  ├─ 新连接 onopen
  ├─ 拉 HTTP getDriverTurns(instanceId)                  ← G9
  │   └─ setMessages(active?.blocks → messages) 之类重建
  ├─ 收 snapshot → setState (config 可能变化)
  ├─ ws.subscribe('global', undefined)                    ← 自带 lastMsgId
  ├─ 收 gap-replay{items, upTo}                           → 逐条分发到 handler
  ├─ 收 ack
  └─ ws.subscribe('instance', instanceId)                 ← G6 + G10
      └─ 收 ack
```

---

## 5. 禁调接口（复习）

按 `INDEX.md` §5，Phase 1 **不允许**调：

- `/api/primary-agent/*` 底层（走 `/api/panel/primary-agent/*`）
- `/api/role-instances/*`、`/api/roster/*`、`/api/teams/*`、`/api/messages/*`（全部走 `/api/panel/*`）
- `/api/sessions/register`（agent bootstrap 专用）
- comm Unix Socket / MCP HTTP（agent 进程专用）
- bus EventBus 直接订阅（只能 WS）
- 已从 WS 白名单移除的 `driver.thinking/text/tool_call/tool_result/turn_done`（改 turn.*）

违反视为硬门禁失败（记忆 #no_direct_backend_api）。代码 review 必查。
