# Turn 聚合前端对接

> **面向**：前端 UI（WS 下行 `turn.*` 事件 + WS 快照查询 `get_turns` + WS 冷历史 `get_turn_history`）。**主 Agent 只有 WS 一个数据源**：实时流、快照、冷历史翻页都走同一条 WS。HTTP 端点 `/api/panel/driver/:id/turns` 与 `/api/panel/driver/:id/turn-history` 仅作为后端内部/调试保留，前端禁调。Agent 不感知 Turn —— Turn 是后端从 agent 的 ACP `sessionUpdate` 聚合出来的产物，仅推给前端。
> 后端权威：`docs/phase-ws/turn-aggregator-design.md`
> 场景：用户在 agent 窗口看 agent 工作过程（思考/回复/调工具/计划/用量）

后端把一轮对话聚合成 **Turn**，Turn 里按 `seq` 排的 **TurnBlock** 就是渲染单元。后端推的 block 是**完整最新状态**（非 delta），前端按 `blockId` upsert 即可。

---

## 1. TS 类型（直接复制）

```typescript
export type TurnBlockType = 'thinking'|'text'|'tool_call'|'plan'|'usage'|'commands'|'mode'|'config'|'session_info';
export type BlockScope = 'turn'|'session';
export type BlockStatus = 'streaming'|'done'|'error';
export type Vendor = 'claude'|'codex';
export type ToolStatus = 'pending'|'in_progress'|'completed'|'failed';
export type ToolKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'switch_mode'|'other';

export type AcpContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'|'audio'; mimeType: string; data: string }
  | { kind: 'diff'; path: string; newText: string; oldText?: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'resource_link'; uri: string; name: string; mimeType?: string };

export interface Location { path: string; line?: number }
export interface VendorPayload { vendor: Vendor; display: string; data: unknown }
export interface VendorOutput extends VendorPayload { exitCode?: number }

// blockId = upsert key；seq 首次出现时分配，此后不变
export interface TurnBlockBase { blockId: string; type: TurnBlockType; scope: BlockScope; status: BlockStatus; seq: number; startTs: string; updatedTs: string }
export interface ThinkingBlock extends TurnBlockBase { type: 'thinking'; scope: 'turn'; messageId?: string; content: string }
export interface TextBlock     extends TurnBlockBase { type: 'text';     scope: 'turn'; messageId?: string; content: string }
export interface ToolCallBlock extends TurnBlockBase { type: 'tool_call'; scope: 'turn'; toolCallId: string; title: string; kind?: ToolKind; toolStatus: ToolStatus; locations?: Location[]; input: VendorPayload; output?: VendorOutput; content?: AcpContent[] }
export interface PlanEntry { content: string; priority: 'high'|'medium'|'low'; status: 'pending'|'in_progress'|'completed' }
export interface PlanBlock  extends TurnBlockBase { type: 'plan';  scope: 'turn'; entries: PlanEntry[] }
export interface UsageBlock extends TurnBlockBase { type: 'usage'; scope: 'turn'; used: number; size: number; cost?: { amount: number; currency: string } }
export interface CommandDescriptor { name: string; description: string; inputHint?: string }
export interface CommandsBlock    extends TurnBlockBase { type: 'commands';     scope: 'session'; commands: CommandDescriptor[] }
export interface ModeBlock        extends TurnBlockBase { type: 'mode';         scope: 'session'; currentModeId: string }
export interface ConfigOption { id: string; category: 'mode'|'model'|'thought_level'; type: 'select'|'toggle'|'text'; currentValue: string|number|boolean; options?: Array<{ id: string; name: string; description?: string }> }
export interface ConfigBlock      extends TurnBlockBase { type: 'config';       scope: 'session'; options: ConfigOption[] }
export interface SessionInfoBlock extends TurnBlockBase { type: 'session_info'; scope: 'session'; title?: string; updatedAt?: string }

export type TurnBlock = ThinkingBlock|TextBlock|ToolCallBlock|PlanBlock|UsageBlock|CommandsBlock|ModeBlock|ConfigBlock|SessionInfoBlock;

export type TurnStatus = 'active'|'done'|'error';
export type StopReason = 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled'|'crashed';
export interface TurnUsage { totalTokens?: number; inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number }
export interface UserInput { text: string; attachments?: AcpContent[]; ts: string }
export interface Turn { turnId: string; driverId: string; status: TurnStatus; userInput: UserInput; blocks: TurnBlock[]; stopReason?: StopReason; usage?: TurnUsage; startTs: string; endTs?: string }
```

---

## 2. WS 推送事件（4 种）

所有事件 payload 外层 `{ type: 'event', event: { ... } }`，下面只给 `event` 内部。

### 2.1 `turn.started` — 新 turn 开始，立即切 loading 态

```json
{ "type": "turn.started", "driverId": "inst_leader_01", "turnId": "turn_abc",
  "userInput": { "text": "帮我分析 /tmp/x.txt", "ts": "2026-04-25T12:00:00.050Z" } }
```

### 2.2 `turn.block_updated` — block 完整最新状态（非 delta）

```json
{
  "type": "turn.block_updated",
  "driverId": "inst_leader_01", "turnId": "turn_abc", "seq": 2,
  "block": {
    "blockId": "call_xyz", "type": "tool_call", "scope": "turn", "status": "done",
    "seq": 2, "startTs": "...", "updatedTs": "...",
    "toolCallId": "call_xyz", "title": "Read x.txt", "kind": "read", "toolStatus": "completed",
    "locations": [{ "path": "/tmp/x.txt" }],
    "input":  { "vendor": "codex", "display": "cat /tmp/x.txt", "data": { "command": ["zsh","-lc","cat /tmp/x.txt"] } },
    "output": { "vendor": "codex", "display": "hello world\n", "exitCode": 0, "data": { "stdout": "hello world\n", "exit_code": 0 } }
  }
}
```

### 2.3 `turn.completed` — turn 结束，完整 turn 归档

```json
{ "type": "turn.completed", "driverId": "inst_leader_01", "turnId": "turn_abc",
  "turn": { "turnId": "turn_abc", "status": "done", "stopReason": "end_turn",
    "userInput": { "text": "...", "ts": "..." }, "blocks": [ /* ... */ ],
    "usage": { "totalTokens": 1234, "inputTokens": 800, "outputTokens": 434 },
    "startTs": "...", "endTs": "..." } }
```

### 2.4 `turn.error` — turn 异常（与 `turn.completed` 同时发，`turn.status='error'`）

```json
{ "type": "turn.error", "driverId": "inst_leader_01", "turnId": "turn_abc", "message": "driver crashed" }
```

生命周期事件（`driver.started` / `driver.stopped` / `driver.error`）仍单独推，用于渲染 agent 在线/离线状态。其余 `driver.*` 已从 WS 白名单移除，前端**不应**依赖。

---

## 3. Block type → 渲染组件

| block.type | scope | 组件 | 渲染要点 |
|---|---|---|---|
| `thinking` | turn | `ThinkingBlock` | 折叠块；`content` 完整字符串，原地覆盖 |
| `text` | turn | `MessageBubble` | agent 气泡；`content` 完整字符串 |
| `tool_call` | turn | `ToolCallCard` | 卡片；渲 `input.display`/`output.display`；`toolStatus` 驱动图标 |
| `plan` | turn | `PlanCard` | 任务清单；`entries` 全量替换 |
| `usage` | turn | `UsageBar` | 底部 token 条；`used`/`size` 画进度 |
| `commands` | session | `CommandsPanel` | 输入框 `/` 弹层 |
| `mode` | session | `ModeIndicator` | 顶栏模式标签 |
| `config` | session | `ConfigPanel` | 设置抽屉 |
| `session_info` | session | `SessionTitle` | 顶栏标题 |

正文 = `blocks.filter(b => b.scope === 'turn').sort((a,b) => a.seq - b.seq)`；session 块广播给顶栏/设置组件。

---

## 4. 快照查询（WS `get_turns`）

> **主 Agent 只有 WS 一个数据源**：前端查 turn 内存快照走 WS op `get_turns`，不走 HTTP。后端保留的 `GET /api/panel/driver/:driverId/turns` 仅内部/调试用。

### 上行

```json
{ "op": "get_turns", "driverId": "inst_leader_01", "limit": 10, "requestId": "r1" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `driverId` | string | 必填；总控用 `PrimaryAgentRow.id`，成员用 `RoleInstance.id` |
| `limit` | number | 可选，默认 10，上限 50；非法值回退默认 |
| `requestId` | string | 可选；下行 `get_turns_response` 原样回填，便于前端对齐 |

### 下行 `get_turns_response`

```json
{
  "type": "get_turns_response",
  "requestId": "r1",
  "active": { "turnId": "turn_cur", "status": "active",
              "userInput": {...}, "blocks": [...], "startTs": "..." },
  "recent": [ { "turnId": "turn_prev", "status": "done", "stopReason": "end_turn",
                "blocks": [...], "endTs": "..." } ]
}
```

- driver 从未跑过 → `active: null`, `recent: []`（不报错）
- `recent` 按 `endTs` 降序（新在前），**不含** `active`
- 每条 Turn 的结构与 `turn.completed` 事件中的 `turn` 字段一致

---

## 5. 前端接入流程

> **原则**：主 Agent 只有 WS 一个数据源。打开窗口、断线重连、上滑翻历史统统通过同一条 WS 完成，不混用 HTTP。

**打开 agent 窗口**
1. `ws.send({ op: 'get_turns', driverId, limit: 20, requestId })`
2. 收 `get_turns_response`（按 `requestId` 对齐）→ `store.active = resp.active`, `store.history = resp.recent`
3. `ws.send({ op: 'subscribe', scope: 'instance', id: driverId, lastMsgId })`
4. 收 `turn.*` 后按下表更新 store

**WS 事件 → store**

| 事件 | 操作 |
|---|---|
| `turn.started` | `active[id] = new Turn(userInput)` |
| `turn.block_updated` | 按 `block.blockId` 在 `active.blocks` upsert（不存在则 append）；session scope 块同时广播给顶栏 |
| `turn.completed` | `history[id].unshift(turn)`（上限 50），`active[id] = null` |
| `turn.error` | `active.status = 'error'` + toast |
| `driver.started` | lifecycle = 'ready' |
| `driver.stopped` | lifecycle = 'stopped'，`active[id] = null`（防悬挂） |
| `driver.error` | lifecycle = 'error' |

**断线重连**

```typescript
async function onWsReconnect() {
  const requestId = nextRequestId();
  ws.send({ op: 'get_turns', driverId, limit: 20, requestId });
  const resp = await waitFor('get_turns_response', requestId);
  store.active[driverId]  = resp.active;
  store.history[driverId] = resp.recent;
  ws.send({ op: 'subscribe', scope: 'instance', id: driverId, lastMsgId });
}
```

主 Agent 只有 WS 一个数据源：先走 WS `get_turns` 拿快照，再 `subscribe` 订阅。`turn.*` 瞬时事件不补发，`get_turns_response` 已覆盖中断期增量。

---

## 6. VendorPayload 渲染规则

`input`/`output` 形如 `{ vendor, display, data }`。

- **默认**：只渲 `display`（adapter 提取的人类可读短串，如 `cat /tmp/x.txt`、`hello world\n`）
- **展开**：用户点「查看原始」→ 按 `vendor` 分派组件
  - `codex`：展开 `data.command` / `data.parsed_cmd`；output 展开 `data.stdout` / `data.stderr` / `data.exit_code` / `data.duration`
  - `claude`：展开 `data` 里的工具原生参数字典 / 原生返回值
- `exitCode` 仅 Codex 填，Claude 无

---

## 7. 注意事项

- `block` 是**完整最新状态**，永远覆盖，不追加字符串。
- `block.seq` 首次分配后不变；前端按 seq 定位，content/toolStatus 原地更新。
- `seq` 每 turn 从 0 重开，不跨 turn 累加。
- `Turn.usage`（turn 结束账单，仅 Claude）和 `UsageBlock`（context 进度条，两家都发）是两件事，可共存分别渲。
- Hub 进程重启 → 内存丢失；冷历史走 WS `get_turn_history`（§8），不需要 localStorage。

---

## 8. Turn 冷历史接口（WS `get_turn_history`）

> §4 的 `get_turns` 返回的是**内存热数据**（进程重启即丢）。本 op 从 SQLite 读**持久化冷历史**，支持 keyset 翻页，用于「查看更多历史对话」场景。**主 Agent 只有 WS 一个数据源**：前端查冷历史走 WS op `get_turn_history`，不走 HTTP。后端保留的 `GET /api/panel/driver/:driverId/turn-history` 仅内部/调试用。

### 上行

```json
{
  "op": "get_turn_history",
  "driverId": "inst_leader_01",
  "limit": 10,
  "beforeEndTs": "2026-04-26T12:00:00Z",
  "beforeTurnId": "turn_abc",
  "requestId": "r2"
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `driverId` | string | — | 必填 |
| `limit` | number | 10 | 每页条数，上限 50；非法值回退默认 |
| `beforeEndTs` | string | — | 游标：上一页最后一条的 `endTs`（ISO） |
| `beforeTurnId` | string | — | 游标：上一页最后一条的 `turnId` |
| `requestId` | string | — | 可选；下行 `get_turn_history_response` 原样回填 |

- `beforeEndTs` 和 `beforeTurnId` **必须成对**，缺一方视为首页
- 排序：`end_ts DESC, turn_id DESC`（新在前）
- 同毫秒多条 Turn 不漂移（composite keyset）

### 下行 `get_turn_history_response`

```json
{
  "type": "get_turn_history_response",
  "requestId": "r2",
  "items": [
    {
      "turnId": "turn_abc",
      "driverId": "pa_01",
      "status": "done",
      "userInput": { "text": "帮我分析...", "ts": "..." },
      "blocks": [ /* TurnBlock[] */ ],
      "stopReason": "end_turn",
      "usage": { "totalTokens": 1234 },
      "startTs": "2026-04-26T12:00:00Z",
      "endTs": "2026-04-26T12:00:05Z"
    }
  ],
  "hasMore": true,
  "nextCursor": { "endTs": "2026-04-26T12:00:00Z", "turnId": "turn_abc" }
}
```

- `hasMore: false` + `nextCursor: null` → 已到末尾
- `items` 为空数组 → 该 driver 无历史记录（不报错）
- 每条 item 的 `Turn` 结构与 `turn.completed` 事件中的 `turn` 字段完全一致

### 前端翻页示例

```typescript
async function loadHistory(driverId: string, cursor?: { endTs: string; turnId: string }) {
  const requestId = nextRequestId();
  ws.send({
    op: 'get_turn_history',
    driverId,
    limit: 20,
    ...(cursor ? { beforeEndTs: cursor.endTs, beforeTurnId: cursor.turnId } : {}),
    requestId,
  });
  const { items, hasMore, nextCursor } = await waitFor('get_turn_history_response', requestId);
  store.history[driverId].push(...items);
  store.historyHasMore[driverId] = hasMore;
  store.historyCursor[driverId] = nextCursor;
}
```

### 与 §4 热快照的关系

| WS op | 数据源 | 包含 active | 持久化 | 用途 |
|---|---|---|---|---|
| `get_turns` (§4)         | 内存 turn-store     | 是               | 否（进程重启丢） | 断线重连恢复当前状态 |
| `get_turn_history` (§8)  | SQLite turn_history | 否（只含已完成） | 是               | 查看历史对话、上滑加载 |

典型流程：先发 §4 `get_turns` 恢复当前状态 → 用户上滑 → 发 §8 `get_turn_history` 翻页加载冷历史。两条 op 共用同一条 WS。
