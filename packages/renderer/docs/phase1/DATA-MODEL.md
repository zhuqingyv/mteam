# DATA-MODEL · 主 Agent 前端数据模型

> 范围：仅 Phase 1 涉及的 store 与跨 store 同步。读此文档前请先看 README.md 的「当前状态」与「缺口」。
>
> 准绳：字段形状 / 状态转换都对齐后端 `docs/frontend-api/primary-agent-api.md`、`ws-protocol.md`、`turn-events.md`。任何背离都是 bug。

---

## 1. primaryAgentStore（`src/store/primaryAgentStore.ts`）

主 Agent 是全项目单例 —— 最多一条 config 记录、最多一个 driver。Store 作为 UI 单一真相源（SSOT）。

### 1.1 字段

```typescript
interface PrimaryAgentSnapshot {
  config: PrimaryAgentRow | null;   // 完整后端行；null = 未配置
  status: 'STOPPED' | 'RUNNING';    // 派生自 config.status；config=null 时恒 'STOPPED'
  instanceId: string | null;        // = config.id；WS prompt / turn 过滤全靠它
  driverLifecycle: 'idle' | 'ready' | 'stopped' | 'error';  // 独立维度；只由 driver.* 事件写
  inflightAction: 'start' | 'stop' | 'configure' | null;    // 防重点击
  lastError: string | null;         // HTTP 失败 / WS error 都打到这
}

interface PrimaryAgentRow {
  id: string;           // 主 Agent instanceId（独立于 role_instances 表，见记忆 #526）
  name: string;
  cliType: string;      // 'claude' | 'codex'（合法 CLI 由后端决定）
  systemPrompt: string;
  mcpConfig: { serverName: string; mode: 'all' | 'whitelist'; tools?: string[] }[];
  status: 'STOPPED' | 'RUNNING';
  createdAt: string;    // ISO
  updatedAt: string;
}
```

### 1.2 数据来源矩阵

| 字段 | 来源优先级 | 说明 |
|---|---|---|
| `config` | WS `snapshot` > `primary_agent.configured.row` > HTTP `GET /api/panel/primary-agent` | snapshot 是建连第一条消息（规定顺序），覆盖一切旧值。`configured` 事件的 `row` 字段是服务端写入后的完整行（权威）。 |
| `status` | `config.status` 派生 | 不独立维护；reset / refresh 后同步更新。记忆 #512。 |
| `instanceId` | `config.id` 派生 | 主 Agent id 只能来自 config，**不得**从 `listInstances().find(leader)` 推断（记忆 #526 教训）。 |
| `driverLifecycle` | WS `driver.started/stopped/error` | 只由 WS 写；HTTP refresh 不动它。driverId !== instanceId 的事件直接忽略。 |
| `inflightAction` | 本地 action 进入 `finally` 清 | 无其他来源。 |
| `lastError` | HTTP 4xx/5xx、WS `error`、action 抛错 | snapshot 成功应清；目前未实现（G14）。 |

### 1.3 状态转换

```
           ┌────── configure (WS/HTTP) ───→ configured ──→ refresh
config     │
  null ────┤
           └────── boot auto-configure ──→ configured ──→ refresh

         ┌── start (HTTP 内部) ──→ RUNNING
STOPPED ─┤
         └── 应用启动 auto-boot ──→ RUNNING

RUNNING ──┬── stop (HTTP 内部) / 退出 ──→ STOPPED
          └── driver 崩溃 self-heal ────→ STOPPED (driverLifecycle=error)

driverLifecycle: idle ──driver.started──→ ready ──driver.stopped──→ stopped
                                              └──driver.error────→ error
```

- snapshot 在 **任何** 连接（首连 / 重连）的第一条消息到达；顺序强保证在 event/ack 之前（`ws-protocol.md` §snapshot）。
- `primary_agent.configured` payload 带完整 `row`，可直接 `applySnapshot(row)`；但当前 store 为省事走 `debouncedRefresh`（150ms）触发 HTTP GET。Phase 1 保留这个设计 —— debouncing 能把 configure→stop→start 三连事件合并成一次 refresh，不浪费请求。
- `driverLifecycle=idle` 是初始值；只在 reset() 时重置。driver 重启会 `idle→ready→stopped→ready` 多次转。

### 1.4 选择器（selectors）

| 选择器 | 语义 |
|---|---|
| `selectOnline` | `status === 'RUNNING'` |
| `selectPaConfig` | `state.config` |
| `selectPaInstanceId` | `state.instanceId`（prompt 要用） |
| `selectInflight` | `state.inflightAction`（按钮禁用态） |
| `selectDriverLifecycle` | `state.driverLifecycle`（展开态顶栏可用显示「在线/离线/出错」微标） |

> **派生真相**：UI 层的「绿点」 = `selectOnline && driverLifecycle === 'ready'`；只看其中一个都会闪烁。记忆 #517 教训。

### 1.5 WS Bridge（`primaryAgentBridge`）

Store **不自己订阅 WS**，由 `useWsEvents` 在分发 `primary_agent.*` / `driver.*` 前缀时调用 bridge：

- `onPrimaryAgentEvent(kind)` → `debouncedRefresh()`（150ms），合并 configure→stop→start 风暴
- `onDriverEvent(kind, driverId)`：
  - `driverId !== state.instanceId` 的事件忽略
  - `instanceId == null` 时补 refresh 一次（防止启动顺序赛马）
  - 否则 `mapDriverLifecycle(kind)` → 写 `driverLifecycle`

> 这个 bridge 是测试难点之一 —— 重构时先保 bridge 的单元测试，再动 store。

---

## 2. messageStore（`src/store/messageStore.ts`）

展开态聊天消息流的 SSOT。

### 2.1 字段

```typescript
interface Message {
  id: string;                 // 用户消息 = 'u-<ts>'；agent 消息 = blockId
  role: 'user' | 'agent';
  content: string;            // 用户原文；agent 为 block.content 最新快照
  time: string;               // 展示用短时间（HH:mm）
  read?: boolean;
  agentName?: string;         // 预留给 Phase 2 成员 Agent
  thinking?: boolean;         // G1/G2 未启用：thinking block 是否在渲染
  toolCalls?: ToolCall[];     // G2 未启用：tool_call block 聚合
  turnId?: string;            // G4/G7 未启用：绑定一个 turn 的所有 block
  blocks?: TurnBlock[];       // G7 未启用：本 turn 所有 block 的原始列表
  streaming?: boolean;        // G4/G7 未启用：true=turn 还未 completed
}

interface TurnBlock {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result';
  blockId: string;            // block 唯一键，upsert
  content?: string;
  toolName?: string;
  status?: string;
  summary?: string;
}
```

### 2.2 actions

| action | 语义 | Phase 1 使用 |
|---|---|---|
| `addMessage(m)` | 追加一条消息 | ✅ ExpandedView.handleSend 本地 echo；agent 首次 block 到达时新建气泡 |
| `replaceMessage(id, m)` | 整体替换 | ✅ text block 增量更新 |
| `setMessages(list)` | 批量覆盖 | ✅ 预留给断线重连拉 turn 快照后重建 |
| `clear()` | 清空 | 切换展开态 / 用户手动清理 |
| `updateTurnBlock(turnId, block)` | 按 turnId + blockId upsert 到 `blocks` | **未启用（G7）** |
| `completeTurn(turnId)` | 置 `streaming=false` | **未启用（G4）** |

### 2.3 当前 Agent 消息写入链路（现状有 Bug，见 G3）

```
WS event { type: 'turn.block_updated', block: { blockId, type:'text', content:'hello world' } }
  └─→ wsEventHandlers.handleTurnEvent
      └─→ 查 messages.find(m.id === blockId)
          ├─ 存在 → replaceMessage(id, { ...existing, content: existing.content + delta })  ❌ 错误累加
          └─ 不存在 → addMessage({ id: blockId, role:'agent', content: delta, time })
```

**正确链路**（Phase 1 修复后）：

```
turn.started        → addMessage({ id:turnId, role:'agent', turnId, streaming:true, blocks:[], time })
turn.block_updated  → updateTurnBlock(turnId, block)       // upsert，content 直接替换（block 是完整状态）
                      若 block.type='text' 且为唯一 text → 同时 replaceMessage 的 content=block.content（让 MessageRow 能读扁平 content）
turn.completed      → completeTurn(turnId)；若 turn.usage 存在则落到 UI
turn.error          → completeTurn(turnId) + toast(message)
```

### 2.4 Message.id 约定

| role | id 格式 | 理由 |
|---|---|---|
| user | `u-${Date.now()}` | 本地唯一即可，不参与后端合并 |
| agent（Phase 1 修复后） | turnId | 一个 turn 一个气泡；内部 blocks 由 blockId 区分 |

> 现状 agent 消息 id = blockId（错位）。下个版本（G7）换成 turnId，blockId 下沉到 `Message.blocks[].blockId`。

---

## 3. wsStore（`src/store/wsStore.ts`）

只存一个活跃 `WsClient` 句柄，供 `ExpandedView.handleSend` 调 `client.prompt()`。非数据模型，记在这里以免找不到。

```typescript
interface WsState { client: WsClient | null; setClient(c): void }
```

生命周期：`useWsEvents` mount 时 setClient(createWsClient)，unmount 时 setClient(null) + close。

---

## 4. 跨 store 同步不变量

| 不变量 | 保证机制 | 破坏后果 |
|---|---|---|
| `primaryAgentStore.instanceId === primaryAgentStore.config?.id` | `refresh` / `applySnapshot` 同步写 | prompt 发错 target，driver events 错过滤 |
| `messages[].turnId` 对应的 turn 属于当前 `primaryAgentStore.instanceId` | `handleTurnEvent` 内比对 `e.driverId === pa.instanceId` | 其他 agent 的 turn 串到主气泡流 |
| `driverLifecycle=ready ⇒ selectOnline=true` | driver.started 到达时 status 已由 primary_agent.started 更新（都走 debouncedRefresh） | UI 绿点闪烁或不亮 |
| `config=null ⇒ instanceId=null ⇒ 禁发 prompt` | ExpandedView.handleSend 先 guard | prompt 带空 instanceId，后端 bad_request |

---

## 5. 持久化 & 重启

- `primaryAgentStore`: 不持久化；每次 renderer 重启走 `useBootstrap` 重新 refresh。
- `messageStore`: 当前**不持久化**（Phase 1 不做本地缓存）；Hub 进程重启后历史消息丢（记忆 #turn-events §7）。后续 Phase 可加 localStorage 缓存 `recent Turn[]`。
- `wsStore.client`: 每次 mount 新建，unmount 关闭；不跨 renderer 生命周期存活。
