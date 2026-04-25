# 服务端事件与数据结构清单（前端 WS 订阅用）

> 任务 #8 产出。来源：
> - `packages/backend/src/bus/types.ts`
> - `packages/backend/src/bus/driver-events.ts`
> - `packages/backend/src/bus/turn-events.ts`
> - `packages/backend/src/agent-driver/types.ts`
> - `packages/backend/src/agent-driver/turn-types.ts`
> - `packages/backend/src/bus/subscribers/ws.subscriber.ts`（WS 白名单）
>
> ⚠️ 这些是**后端内部 interface**。前端 WS JSON 形状的正式契约属于 `[待 D2]`（Turn 前端接口）与 `[待 D5]`（架构总览）。本文档用作"参考与盲区地图"，禁止直接硬编码解析到 prod。

---

## 0. 路径与 `/api/panel/` 门禁的关系（开工前必读）

**服务端当前 WS 路径**：`/ws/events`（见 `packages/backend/src/bus/ws-upgrade.ts`）。

**待裁决**：mnemo 硬门禁 `feedback_no_direct_backend_api` 原文仅约束 HTTP（"只允许通过 `/api/panel/`"），**未明确 WS 是否同样受约束**。严格按字面，`/ws/events` 不违规；但按同样的隔离精神（面板 facade），应该迁到 `/ws/panel/events`。

**前端执行策略**（等 team-lead 裁决）：
- 短期：如 team-lead 确认 WS 不受门禁，直连 `/ws/events`；
- 中长期（推荐）：服务端随 D6 facade 一并暴露 `/ws/panel/events`，前端只连这个；
- 两种情况下，本文档列出的事件类型和数据结构均不变，只是连接路径不同。

---

## 1. 事件公共结构

所有事件都以 `BusEventBase` 为基：

```ts
interface BusEventBase {
  type: string;          // 见下表事件名
  ts: string;            // ISO 8601
  source: string;        // 后端标记发源，WS 推送前会剥除
  correlationId?: string;// 同上
  eventId?: string;      // A5 接线：下行唯一 id（comm.* 继续用 messageId）
}
```

**WS 推送前**的剥除逻辑（`ws.subscriber.ts::toWsPayload`）：
- 剥除 `source`、`correlationId`
- 保留其余全部字段（含 `type` / `ts` / `eventId` + 业务字段）

---

## 2. WS 白名单（前端能收到的事件）

`ws.subscriber.ts::WS_EVENT_TYPES` —— 34 个事件类型。未列入白名单的事件（如 `container.*` 的某些内部事件、部分 driver.*）不会推到前端。

按域分 9 组：

### 2.1 instance.*（角色实例生命周期）

| type | 关键字段 |
|---|---|
| `instance.created` | `instanceId`、`templateName`、`memberName`、`isLeader`、`teamId\|null`、`task\|null` |
| `instance.activated` | `instanceId`、`actor\|null` |
| `instance.offline_requested` | `instanceId`、`requestedBy`、`reason?`（`explicit_deny`\|`not_in_whitelist`\|自定义） |
| `instance.deleted` | `instanceId`、`previousStatus`、`force`、`teamId\|null`、`isLeader`（服务端在级联删除前抓的快照） |
| `instance.session_registered` | `instanceId`、`claudeSessionId` |

### 2.2 comm.*（通讯）

| type | 关键字段 |
|---|---|
| `comm.registered` | `address` |
| `comm.disconnected` | `address` |
| `comm.message_sent` | `messageId`、`from`、`to` |
| `comm.message_received` | `messageId`、`from`、`to`、`route` |

### 2.3 template.*（角色模板）

| type | 关键字段 |
|---|---|
| `template.created` | `templateName` |
| `template.updated` | `templateName` |
| `template.deleted` | `templateName` |

### 2.4 mcp.*（MCP 安装）

| type | 关键字段 |
|---|---|
| `mcp.installed` | `mcpName` |
| `mcp.uninstalled` | `mcpName` |

### 2.5 team.*（团队）

| type | 关键字段 |
|---|---|
| `team.created` | `teamId`、`name`、`leaderInstanceId` |
| `team.disbanded` | `teamId`、`reason`（`manual`\|`empty`\|`leader_gone`） |
| `team.member_joined` | `teamId`、`instanceId`、`roleInTeam\|null` |
| `team.member_left` | `teamId`、`instanceId`、`reason`（`manual`\|`instance_deleted`\|`offline_requested`） |

### 2.6 cli.*（CLI 可用性）

| type | 关键字段 |
|---|---|
| `cli.available` | `cliName`、`path`、`version\|null` |
| `cli.unavailable` | `cliName` |

### 2.7 primary_agent.*（总控）

| type | 关键字段 |
|---|---|
| `primary_agent.configured` | `agentId`、`cliType`、`name` |
| `primary_agent.started` | `agentId`、`cliType` |
| `primary_agent.stopped` | `agentId` |

### 2.8 driver.*（只部分进入 WS 白名单：started/stopped/error）

WS 白名单**仅**放行：`driver.started / driver.stopped / driver.error`。
其余 driver.* 事件（thinking/text/tool_call/tool_update/plan/commands/mode/config/session_info/usage/turn_start/turn_done）**不直接推前端**，由 `turn-aggregator.subscriber` 聚合为 `turn.*` 后转推。

| type（推前端） | 关键字段 |
|---|---|
| `driver.started` | `driverId`、`pid?` |
| `driver.stopped` | `driverId` |
| `driver.error` | `driverId`、`message` |

### 2.9 turn.*（由 TurnAggregator 产出，前端聊天主数据源）

| type | 关键字段 |
|---|---|
| `turn.started` | `driverId`、`turnId`、`userInput: UserInput` |
| `turn.block_updated` | `driverId`、`turnId`、`seq`（== `block.seq`）、`block: TurnBlock` |
| `turn.completed` | `driverId`、`turnId`、`turn: Turn`（完整成交快照） |
| `turn.error` | `driverId`、`turnId`、`message` |

### 2.10 container.*（沙箱生命周期）

| type | 关键字段 |
|---|---|
| `container.started` | `agentId`、`runtimeKind`（`host`\|`docker`）、`containerId` |
| `container.exited` | `agentId`、`reason`（`stop_requested`\|`max_restart_exceeded`\|`normal_exit`）、`exitCode\|null` |
| `container.crashed` | `agentId`、`cliType`、`exitCode`、`signal\|null` |

### 2.11 notification.*（通知路由结果）

| type | 关键字段 |
|---|---|
| `notification.delivered` | `target`（`{kind:'user',id}` 或 `{kind:'agent',id}`）、`sourceEventType`、`sourceEventId` |

> 前端按 `sourceEventId` 在本地事件缓存反查原事件；**不携带** sourceEventPayload，避免同订 global + 通知造成的双推。

---

## 3. 核心数据结构（Turn / TurnBlock / 相关）

> 下面 TS 类型来自后端源码。前端仅作参考，正式字段名与嵌套层次以 D2 文档为准。

### 3.1 Turn

```ts
interface Turn {
  turnId: string;
  driverId: string;
  status: 'active' | 'done' | 'error';
  userInput: UserInput;
  blocks: TurnBlock[];
  stopReason?: StopReason;     // 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'crashed'
  usage?: TurnUsage;            // 仅 Claude 返回
  startTs: string;
  endTs?: string;
}

interface UserInput {
  text: string;
  attachments?: AcpContent[];
  ts: string;
}

interface TurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}
```

### 3.2 TurnBlock（9 种子类）

公共基字段：

```ts
interface TurnBlockBase {
  blockId: string;
  type: TurnBlockType;          // 见下
  scope: 'turn' | 'session';    // session 级块跨 turn 存活
  status: 'streaming' | 'done' | 'error';
  seq: number;                  // 本 turn 内单调递增
  startTs: string;
  updatedTs: string;
}

type TurnBlockType =
  | 'thinking' | 'text' | 'tool_call'
  | 'plan' | 'usage'
  | 'commands' | 'mode' | 'config' | 'session_info';
```

| Block | 额外字段 | Scope |
|---|---|---|
| `ThinkingBlock` | `messageId?`、`content: string` | turn |
| `TextBlock` | `messageId?`、`content: string` | turn |
| `ToolCallBlock` | `toolCallId`、`title`、`kind?`、`toolStatus`（pending/in_progress/completed/failed）、`locations?`、`input: VendorPayload`、`output?: VendorOutput`、`content?: AcpContent[]` | turn |
| `PlanBlock` | `entries: PlanEntry[]`（content/priority/status） | turn |
| `UsageBlock` | `used`、`size`、`cost?: {amount,currency}` | turn |
| `CommandsBlock` | `commands: CommandDescriptor[]`（name/description/inputHint?） | **session** |
| `ModeBlock` | `currentModeId` | **session** |
| `ConfigBlock` | `options: ConfigOption[]`（id/category/type/currentValue/options?） | **session** |
| `SessionInfoBlock` | `title?`、`updatedAt?` | **session** |

### 3.3 ACP Content / VendorPayload

```ts
type AcpContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'audio'; mimeType: string; data: string }
  | { kind: 'diff'; path: string; newText: string; oldText?: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'resource_link'; uri: string; name: string; mimeType?: string };

interface VendorPayload { vendor: 'claude' | 'codex'; display: string; data: unknown; }
interface VendorOutput extends VendorPayload { exitCode?: number; }

type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
```

---

## 4. 前端聚合语义提示（读代码得出，以 D2 文档为权威）

- `turn.block_updated.block` 是**完整当前态**（非 delta），前端按 `blockId` upsert；不存在则按 `seq` append。
- `turn.completed.turn.blocks` 是完整成交版，前端收到可直接归档到 history。
- `turn.started` 到来时就切"正在思考"loading 态，避免等 thinking 的第一个 block_updated。
- `turn.error` 与 `turn.completed` 可能同时发；前端按 turnId 去重。
- session 级 block（commands / mode / config / session_info）跨 turn 保留，不要在切 turn 时清。

---

## 5. 前端盲区（统一挂到 PRD §0.1）

| 盲区 | 依赖文档 |
|---|---|
| WS JSON 字段命名 / 大小写 / 是否 camelCase 稳定 | D2 |
| 白名单是否稳定契约（`WS_EVENT_TYPES` 会不会变） | D5 |
| 重连补偿：WS 断开重连后前端需要先拉 HTTP Turn 快照，还是服务端会 replay？ | D2 + D5 |
| `comm.message_received` 与 `/api/messages/:id` 如何配合（拉还是推） | D1 |
| `notification.delivered.target=agent` 前端要不要渲染 | D3 |

---

文档路径：`/Users/zhuqingyu/project/mcp-team-hub/packages/renderer/SERVER-EVENTS-INDEX.md`
