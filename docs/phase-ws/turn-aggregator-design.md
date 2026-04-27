# Turn 聚合方案 · Adapter 补全 · 前端结构化输出规范

> 版本：v1 · 日期：2026-04-25 · 架构师：architect-turn · 对抗：reviewer-turn
>
> **受众与面向分层**（避免误读）：
> - **后端实现者**：§2 DriverEvent / §3 Adapter / §4 TurnAggregator / §7 模块拆分 / §8 任务拆分 —— **后端内部**，前端不消费、不实现。
> - **前端 / 后端共享契约**：§1 Turn / TurnBlock TS 类型（跨进程共享）、§5 WS 推送 JSON、§4.8 HTTP 恢复接口、§6 前端渲染建议。
> - **前端开发者**：只需看 §1（类型定义）、§4.8（HTTP）、§5（WS 消息）、§6（UI 渲染）；其余章节属后端实现细节，不要按 §2/§3 的 `DriverEvent` 自己处理，前端只接收 §5 的 `turn.*` WS 事件。
>
> 前置调研：`acp-claude-messages.md`、`acp-codex-messages.md`
> 相关：`MILESTONE.md` §5.5（agent 回复 = driver.text）、`TASK-LIST.md` §W2-2（ws-broadcaster）
> reviewer-turn 审查后修订（A/B/C/D/E/F/G/H/I 全部采纳，已落地）

---

## 0. 设计目标

1. 把 ACP 11 种 `sessionUpdate` 的信息**完整**喂到前端（当前 adapter 只认 4 种 + 丢一堆字段）
2. 把 driver 零散事件流**聚合成 Turn**（完整一轮对话），前端按 Turn 渲染
3. 抹平 Claude / Codex 两家的 `rawInput` / `rawOutput` 形状差异（adapter 提取 display 归一化）
4. 支持**增量推送**（WS 小包），前端本地维护完整 Turn，不依赖后端每次全量推
5. **断线重连可恢复**（HTTP 接口拉活跃 Turn + 最近 N 条历史）
6. 生命周期事件（driver.started/stopped/error）保留独立事件流，前端可单独渲染「agent 离线/上线」

---

## 1. Turn / TurnBlock 完整 TS 定义

> **面向**：**前端 + 后端共享契约**。前端从 `renderer/types/turn.ts`（本期手动复制自后端 `agent-driver/turn-types.ts`）导入；后端 agent-driver / bus / turn-aggregator / ws-broadcaster 共用同一套定义。

### 1.1 TurnBlock 分类（9 种）

| type | 来源 sessionUpdate | 合并 key | scope | 说明 |
|------|-------------------|---------|-------|------|
| `thinking` | agent_thought_chunk | messageId | turn | agent 思考块 |
| `text` | agent_message_chunk | messageId | turn | agent 正式回复 |
| `tool_call` | tool_call + tool_call_update | toolCallId | turn | 工具调用（中间态 + 终态合并） |
| `plan` | plan | 固定 `plan-{turnId}` | turn | 全量替换；本 turn 最新一份 |
| `usage` | usage_update | 固定 `usage-{turnId}` | turn | Codex 每 turn 发，turn 级 |
| `commands` | available_commands_update | 固定 `commands` | session | 会话级 slash-command 列表 |
| `mode` | current_mode_update | 固定 `mode` | session | 会话级模式 |
| `config` | config_option_update | 固定 `config` | session | 会话级配置 |
| `session_info` | session_info_update | 固定 `session_info` | session | 会话级标题等 |

采用 reviewer **E 条**建议：**不拆两层**；`block.scope` 字段区分，前端自己按 scope 决定渲染位置（正文 vs 顶栏）。

### 1.2 完整 TS 类型

```typescript
// packages/backend/src/agent-driver/turn-types.ts
// 纯类型文件；给 agent-driver、bus、ws-broadcaster、前端共用。

export type TurnBlockType =
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'plan'
  | 'usage'
  | 'commands'
  | 'mode'
  | 'config'
  | 'session_info';

export type BlockScope = 'turn' | 'session';

export type Vendor = 'claude' | 'codex';

export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'audio'; mimeType: string; data: string }
  | { kind: 'diff'; path: string; newText: string; oldText?: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'resource_link'; uri: string; name: string; mimeType?: string };

export interface Location {
  path: string;
  line?: number;
}

/**
 * 厂商载荷。reviewer B 条：adapter 必须提取 `display`（人类可读短字符串），
 * 前端默认渲 display；高级用户展开 data 看原始 vendor 形状。
 */
export interface VendorPayload {
  vendor: Vendor;
  display: string;       // adapter 提取；必填
  data: unknown;         // 原始 rawInput / rawOutput，透传
}

export interface VendorOutput extends VendorPayload {
  exitCode?: number;     // Codex rawOutput.exit_code；Claude 工具成功/失败各自形状
}

// ---------- Block 基类 ----------

export interface TurnBlockBase {
  blockId: string;        // 合并 key：messageId / toolCallId / 固定字符串 / UUID
  type: TurnBlockType;
  scope: BlockScope;
  status: 'streaming' | 'done' | 'error';
  /** 本 turn 内单调递增，块**首次出现**时分配；前端按 seq 固定位置，content 原地更新。 */
  seq: number;
  startTs: string;        // ISO 8601
  updatedTs: string;
}

// ---------- 9 种 Block 具体形状 ----------

export interface ThinkingBlock extends TurnBlockBase {
  type: 'thinking';
  scope: 'turn';
  messageId?: string;
  content: string;        // adapter 拼好的完整字符串（不是 delta）
}

export interface TextBlock extends TurnBlockBase {
  type: 'text';
  scope: 'turn';
  messageId?: string;
  content: string;
}

export interface ToolCallBlock extends TurnBlockBase {
  type: 'tool_call';
  scope: 'turn';
  toolCallId: string;
  title: string;          // LLM 生成，"Read /etc/hostname"
  kind?: ToolKind;
  toolStatus: ToolStatus;
  locations?: Location[];
  input: VendorPayload;
  output?: VendorOutput;
  content?: AcpContent[]; // ACP ToolCallContent[]（diff / terminal / resource_link 等）
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanBlock extends TurnBlockBase {
  type: 'plan';
  scope: 'turn';
  entries: PlanEntry[];
}

export interface UsageBlock extends TurnBlockBase {
  type: 'usage';
  scope: 'turn';
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface CommandDescriptor {
  name: string;
  description: string;
  inputHint?: string;
}

export interface CommandsBlock extends TurnBlockBase {
  type: 'commands';
  scope: 'session';
  commands: CommandDescriptor[];
}

export interface ModeBlock extends TurnBlockBase {
  type: 'mode';
  scope: 'session';
  currentModeId: string;
}

export interface ConfigOption {
  id: string;
  category: 'mode' | 'model' | 'thought_level';
  type: 'select' | 'toggle' | 'text';
  currentValue: string | number | boolean;
  options?: Array<{ id: string; name: string; description?: string }>;
}

export interface ConfigBlock extends TurnBlockBase {
  type: 'config';
  scope: 'session';
  options: ConfigOption[];
}

export interface SessionInfoBlock extends TurnBlockBase {
  type: 'session_info';
  scope: 'session';
  title?: string;
  updatedAt?: string;
}

export type TurnBlock =
  | ThinkingBlock | TextBlock | ToolCallBlock
  | PlanBlock | UsageBlock
  | CommandsBlock | ModeBlock | ConfigBlock | SessionInfoBlock;

// ---------- Turn ----------

export type TurnStatus = 'active' | 'done' | 'error';

export type StopReason =
  | 'end_turn' | 'max_tokens' | 'max_turn_requests'
  | 'refusal' | 'cancelled' | 'crashed';     // reviewer A：补 'crashed'

/**
 * TurnUsage —— 来自 `session/prompt` 响应的 token 细分（Claude 响应带，Codex 响应只带 stopReason）。
 * 与 `UsageBlock` 不同：UsageBlock 来自 `usage_update` sessionUpdate 事件（两家都发），表达的是
 * **context window 进度**（used/size/cost），粒度粗；TurnUsage 是 **turn 结束时的 token 细分**
 * （input/output/thought/cached 分别多少），粒度细。两者可同时存在，前端分别渲：
 *   - UsageBlock → 底部 context 条（实时，turn 进行中都可能更新）
 *   - Turn.usage → turn 结束后的账单小卡（仅 Claude 有；Codex 为 undefined）
 */
export interface TurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/**
 * 用户消息 —— reviewer I：Turn 里必须有 userInput，否则前端渲 [用户气泡, ...agent 块] 没地方放。
 */
export interface UserInput {
  text: string;
  attachments?: AcpContent[];   // 可能带图片 / 文件引用；ACP ContentBlock 兼容
  ts: string;
}

export interface Turn {
  turnId: string;               // prompt UUID；driver.prompt() 前分配
  driverId: string;             // = role_instance_id
  status: TurnStatus;
  userInput: UserInput;         // reviewer I 条
  blocks: TurnBlock[];          // 按 seq 升序
  stopReason?: StopReason;
  usage?: TurnUsage;            // turn 结束时的最终 usage（由 session/prompt 响应提供，Claude 有、Codex 无）
  startTs: string;
  endTs?: string;
}
```

### 1.3 合并 key 约定（blockId）

| Block | blockId 规则 |
|-------|-------------|
| thinking | `messageId` 存在 → 用它；否则 `thinking-{turnId}`（同 turn 无 messageId 的思考合并为一块） |
| text | 同上 |
| tool_call | `toolCallId`（ACP 保证 session 内唯一） |
| plan | 固定 `plan-{turnId}` |
| usage | 固定 `usage-{turnId}` |
| commands | 固定 `commands`（session 级，不带 turnId） |
| mode | 固定 `mode` |
| config | 固定 `config` |
| session_info | 固定 `session_info` |

---

## 2. DriverEvent 扩展清单

> ⛔ **服务端底层接口，禁止前端调用**
>
> **面向**：**后端内部**（`agent-driver` → `bus-bridge` → bus subscriber）。
> **非面向**：前端。前端不接触 `DriverEvent`；聚合器把它们转成 `turn.*` 事件后才推前端（见 §5）。前端开发者读到此章节**不要**自己实现 DriverEvent 的消费逻辑。

### 2.1 现有（需要改）

```typescript
// 当前 types.ts:27-32 所有 5 个事件都要动
- { type: 'driver.thinking'; content: string }
- { type: 'driver.text'; content: string }
- { type: 'driver.tool_call'; toolCallId; name; input }
- { type: 'driver.tool_result'; toolCallId; output; ok }     // 重命名为 tool_update
- { type: 'driver.turn_done'; stopReason }                    // 加 turnId、usage
```

### 2.2 改动后的完整 DriverEvent（12 种）

```typescript
// packages/backend/src/agent-driver/types.ts
// 引用 turn-types 避免重复定义

import type {
  Vendor, ToolKind, ToolStatus, Location, AcpContent,
  PlanEntry, CommandDescriptor, ConfigOption, TurnUsage, StopReason,
  VendorPayload, VendorOutput, UserInput,
} from './turn-types.js';

export type DriverEvent =
  // —— 已有，加字段 ——
  | { type: 'driver.thinking'; messageId?: string; content: string }
  | { type: 'driver.text'; messageId?: string; content: string }
  | { type: 'driver.tool_call';
      toolCallId: string;
      title: string;
      kind?: ToolKind;
      status: ToolStatus;          // 初始状态（Claude 一般 pending，Codex 常 in_progress）
      locations?: Location[];
      input: VendorPayload;
      content?: AcpContent[];      // 创建时可能带初始 content（ACP 允许，Codex 实测不带）
    }
  | { type: 'driver.tool_update';  // reviewer D：改名 tool_result → tool_update，一次改到位
      toolCallId: string;
      status?: ToolStatus;
      title?: string;
      kind?: ToolKind;
      locations?: Location[];
      output?: VendorOutput;
      content?: AcpContent[];      // ACP 语义是全量替换
    }
  // —— 新增（前端 UI 需要）——
  | { type: 'driver.plan'; entries: PlanEntry[] }
  | { type: 'driver.commands'; commands: CommandDescriptor[] }
  | { type: 'driver.mode'; currentModeId: string }
  | { type: 'driver.config'; options: ConfigOption[] }
  | { type: 'driver.session_info'; title?: string; updatedAt?: string }
  | { type: 'driver.usage'; used: number; size: number; cost?: { amount: number; currency: string } }
  // —— Turn 边界 ——
  | { type: 'driver.turn_start'; turnId: string; userInput: UserInput }   // reviewer I：带 userInput
  | { type: 'driver.turn_done'; turnId: string; stopReason: StopReason; usage?: TurnUsage };
```

### 2.3 字段补全对照表

| sessionUpdate | 原 adapter 映射 | 改后 DriverEvent | 补字段 |
|---------------|----------------|-----------------|--------|
| agent_thought_chunk | `driver.thinking {content}` | `driver.thinking {messageId, content}` | messageId |
| agent_message_chunk | `driver.text {content}` | `driver.text {messageId, content}` | messageId |
| tool_call | `driver.tool_call {toolCallId, name, input}` | `driver.tool_call {toolCallId, title, kind, status, locations, input:VendorPayload, content}` | title 改正语义；补 kind/status/locations/content；input 加 vendor+display |
| tool_call_update | `driver.tool_result {toolCallId, output, ok}`（仅 completed/failed） | `driver.tool_update {toolCallId, status, title?, kind?, locations?, output:VendorOutput, content?}` | **重命名**；**中间态也发**（in_progress）；补字段；output 加 vendor+display |
| plan | **未处理** | `driver.plan {entries}` | 全新 |
| available_commands_update | **未处理** | `driver.commands {commands}` | 全新 |
| current_mode_update | **未处理** | `driver.mode {currentModeId}` | 全新 |
| config_option_update | **未处理** | `driver.config {options}` | 全新 |
| session_info_update | **未处理** | `driver.session_info {title, updatedAt}` | 全新 |
| usage_update | **未处理** | `driver.usage {used, size, cost}` | 全新 |
| (driver.prompt 前) | **未处理** | `driver.turn_start {turnId, userInput}` | 全新 |
| (session/prompt response) | `driver.turn_done {stopReason}` | `driver.turn_done {turnId, stopReason, usage}` | 补 turnId / usage |

`user_message_chunk` 两家实测不发，暂不映射；未来需要时加 `driver.user_message_echo`。

### 2.4 bus 事件同步扩展

`bus/types.ts` 里 `DriverToolResultEvent` → `DriverToolUpdateEvent`；补新 7 类；`DriverTextEvent` / `DriverThinkingEvent` 加 `messageId?`；`DriverTurnDoneEvent` 加 `turnId` / `usage?`。

新增 **Turn 聚合事件**（给 ws-broadcaster 和 HTTP 查询接口读）：

```typescript
export interface TurnBlockUpdatedEvent extends BusEventBase {
  type: 'turn.block_updated';
  driverId: string;
  turnId: string;
  block: TurnBlock;        // 完整最新状态（不是 diff），前端按 blockId 替换
  seq: number;             // = block.seq；冗余放外层方便路由过滤
}

export interface TurnCompletedEvent extends BusEventBase {
  type: 'turn.completed';
  driverId: string;
  turnId: string;
  turn: Turn;              // 完整成交版本；归档到前端本地历史
}

export interface TurnErrorEvent extends BusEventBase {
  type: 'turn.error';
  driverId: string;
  turnId: string;
  message: string;
}
```

---

## 3. Adapter 改动方案

> ⛔ **服务端底层接口，禁止前端调用**
>
> **面向**：**后端内部** `agent-driver/adapters/*`。前端无关。

### 3.1 两家 adapter 共享改动

**新增文件** `adapters/normalize.ts`（vendor-agnostic 工具，reviewer **H 条**拆分）:

- `contentBlockToAcpContent(cb: unknown): AcpContent | null` —— ACP ContentBlock → 我们的 `AcpContent`
- `toolCallContentToAcpContent(tcc: unknown): AcpContent | null` —— ACP `ToolCallContent[]` 一项 → `AcpContent`
- `compactAcpContent(raw: unknown[] | null | undefined): AcpContent[]` —— 批量转换 + 类型守卫过滤 null；**adapter 必须用这个而不是裸 `.map().filter(Boolean)`**（reviewer P1：`filter(Boolean)` 在 TS 不会窄化 `(AcpContent|null)[]` → `AcpContent[]`，会导致编译被迫 `as AcpContent[]` 强转，埋 runtime 类型假设）
- `extractText(update: unknown): string` —— 从 sessionUpdate.content 取纯文本（现有函数提出去）
- `normalizePlanEntries(raw: unknown): PlanEntry[]`
- `normalizeCommands(raw: unknown): CommandDescriptor[]`
- `normalizeConfigOptions(raw: unknown): ConfigOption[]`
- `normalizeLocations(raw: unknown): Location[] | undefined`
- `mapToolKind(raw: unknown): ToolKind | undefined`
- `mapToolStatus(raw: unknown): ToolStatus`

`compactAcpContent` 参考实现：

```typescript
export function compactAcpContent(raw: unknown[] | null | undefined): AcpContent[] {
  if (!raw) return [];
  return raw
    .map(toolCallContentToAcpContent)
    .filter((c): c is AcpContent => c !== null);
}
```

估计 `normalize.ts` ≤ 200 行。

### 3.2 ClaudeAdapter（`adapters/claude.ts`）改动

```typescript
// prepareLaunch / sessionParams / cleanup 不动
parseUpdate(update: unknown): DriverEvent | null {
  switch (u.sessionUpdate) {
    case 'agent_thought_chunk':
      return { type: 'driver.thinking',
               messageId: getMessageId(u),
               content: extractText(u) };

    case 'agent_message_chunk':
      return { type: 'driver.text',
               messageId: getMessageId(u),
               content: extractText(u) };

    case 'tool_call': {
      const t = u as RawToolCall;
      return {
        type: 'driver.tool_call',
        toolCallId: t.toolCallId,
        title: t.title ?? '',
        kind: mapToolKind(t.kind),
        status: mapToolStatus(t.status ?? 'pending'),
        locations: normalizeLocations(t.locations),
        input: {
          vendor: 'claude',
          display: describeClaudeToolInput(t.title, t.rawInput),  // adapter 提取
          data: t.rawInput,
        },
        content: compactAcpContent(t.content),
      };
    }

    case 'tool_call_update': {
      const t = u as RawToolCallUpdate;
      return {
        type: 'driver.tool_update',
        toolCallId: t.toolCallId,
        status: mapToolStatus(t.status),
        title: t.title ?? undefined,
        kind: mapToolKind(t.kind),
        locations: normalizeLocations(t.locations),
        output: t.rawOutput !== undefined ? {
          vendor: 'claude',
          display: describeClaudeToolOutput(t.rawOutput),
          data: t.rawOutput,
        } : undefined,
        content: t.content != null ? compactAcpContent(t.content) : undefined,
      };
    }

    case 'plan':
      return { type: 'driver.plan', entries: normalizePlanEntries((u as any).entries) };

    case 'available_commands_update':
      return { type: 'driver.commands',
               commands: normalizeCommands((u as any).availableCommands) };

    case 'current_mode_update':
      return { type: 'driver.mode', currentModeId: (u as any).currentModeId };

    case 'config_option_update':
      return { type: 'driver.config',
               options: normalizeConfigOptions((u as any).configOptions) };

    case 'session_info_update':
      return { type: 'driver.session_info',
               title: (u as any).title ?? undefined,
               updatedAt: (u as any).updatedAt ?? undefined };

    case 'usage_update':
      return { type: 'driver.usage',
               used: (u as any).used,
               size: (u as any).size,
               cost: (u as any).cost ?? undefined };

    default:
      return null;
  }
}
```

**ClaudeAdapter display 提取（放 adapter 自己，非 vendor-agnostic）**:

```typescript
// describeClaudeToolInput 举例
function describeClaudeToolInput(title: string, raw: unknown): string {
  // Claude 的 rawInput 就是工具原生参数字典，常见：
  // Read → { file_path, offset?, limit? }
  // Bash → { command, description? }
  // Edit → { file_path, old_string, new_string }
  if (!raw || typeof raw !== 'object') return title;
  const r = raw as Record<string, unknown>;
  if (typeof r.file_path === 'string') return `${title}: ${r.file_path}`;
  if (typeof r.command === 'string') return `${title}: ${r.command}`;
  return title;
}
```

估 `claude.ts` ≤ 180 行。

### 3.3 CodexAdapter（`adapters/codex.ts`）改动

parseUpdate 逻辑与 Claude 基本一致（ACP 共享同一 schema），差异只在 display 提取：

```typescript
// describeCodexToolInput —— Codex rawInput 是 unified_exec 形状
function describeCodexToolInput(title: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object') return title;
  const r = raw as { command?: unknown[]; parsed_cmd?: Array<{ cmd?: string }> };
  const parsed = r.parsed_cmd?.[0]?.cmd;
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(r.command)) {
    const last = r.command.at(-1);
    if (typeof last === 'string') return last;
  }
  return title;
}

// describeCodexToolOutput —— Codex rawOutput.formatted_output 是成品字符串
function describeCodexToolOutput(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as { formatted_output?: unknown; aggregated_output?: unknown };
  if (typeof r.formatted_output === 'string') return r.formatted_output;
  if (typeof r.aggregated_output === 'string') return r.aggregated_output;
  return '';
}

function extractCodexExitCode(raw: unknown): number | undefined {
  const r = raw as { exit_code?: unknown };
  return typeof r?.exit_code === 'number' ? r.exit_code : undefined;
}
```

`output.exitCode` 字段仅 Codex 会填（Claude 工具不是 shell 语义）。

估 `codex.ts` ≤ 200 行。

### 3.4 AgentAdapter 接口不变

`prepareLaunch` / `sessionParams` / `parseUpdate` / `cleanup` 四个方法签名稳定。只有 parseUpdate 返回的 DriverEvent 联合类型扩大（TS 编译器能卡住所有消费方）。

---

## 4. TurnAggregator 架构

> ⛔ **§4.1~§4.7 是服务端底层接口，禁止前端调用**（§4.8 HTTP 恢复接口除外，见下）
>
> **面向**：**后端内部**。§4.1~§4.7 是后端聚合器实现细节，前端不消费、不实现。
> **§4.8 是例外**：HTTP 恢复接口是**前端消费的契约**，标注另列。

### 4.1 ASCII 架构图

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                           一条 prompt 的完整链路                                │
 └──────────────────────────────────────────────────────────────────────────────┘

   前端 WS                后端                        ACP agent 进程
  ┌──────┐  ①{op:prompt}  ┌─────────────┐                 ┌─────────────┐
  │      │ ─────────────► │ ws-handler  │                 │  claude/    │
  │      │                │  .ts        │                 │  codex-acp  │
  │      │                └──────┬──────┘                 │             │
  │      │                       │ driver.prompt(text)    │             │
  │      │                       ▼                        │             │
  │      │                ┌─────────────┐ ② turn_start    │             │
  │      │                │ AgentDriver │─── emit ───────►│ session/    │
  │      │                │             │                 │  prompt     │
  │      │                │ - 分配      │                 │             │
  │      │                │   turnId    │                 │             │
  │      │                │ - emit      │                 │             │
  │      │                │   turn_start│                 │             │
  │      │                └──────┬──────┘                 └──────┬──────┘
  │      │                       │                               │
  │      │                       │ ③ ACP sessionUpdate × N       │
  │      │                       │◄──────────────────────────────┘
  │      │                       ▼
  │      │                ┌─────────────┐
  │      │                │ adapter.    │
  │      │                │ parseUpdate │
  │      │                │             │ 补齐 11 种 + vendor display
  │      │                └──────┬──────┘
  │      │                       ▼ DriverEvent
  │      │                ┌─────────────┐
  │      │                │ emitter.    │
  │      │                │ emit        │──► events$ (Observable)
  │      │                └──────┬──────┘
  │      │                       ▼
  │      │                ┌─────────────────┐
  │      │                │ bus-bridge      │ translate(driverId, ev)
  │      │                │ (attachDriver   │
  │      │                │  ToBus)         │
  │      │                └──────┬──────────┘
  │      │                       ▼ BusEvent (driver.*)
  │      │                ┌─────────────────────────────┐
  │      │                │   EventBus                  │
  │      │                └──────┬──────────┬───────────┘
  │      │                       │          │
  │      │           ┌───────────┘          └─────────────┐
  │      │           ▼                                    ▼
  │      │   ┌───────────────┐              ┌─────────────────────┐
  │      │   │ turn-         │              │ 其他订阅者          │
  │      │   │ aggregator.   │              │ (log/domain-sync)   │
  │      │   │ subscriber    │              └─────────────────────┘
  │      │   │               │
  │      │   │ Map<driverId, │
  │      │   │  Turn>        │
  │      │   │               │ ④ 每条 driver.* → 更新 Block
  │      │   │               │                → emit turn.block_updated
  │      │   │               │    driver.turn_done → emit turn.completed
  │      │   │               │    driver.stopped/error → 强制关闭 active Turn
  │      │   └───────┬───────┘
  │      │           ▼
  │      │   ┌───────────────┐
  │      │   │  EventBus      │  turn.block_updated / turn.completed / turn.error
  │      │   └───────┬────────┘
  │      │           ▼
  │      │   ┌────────────────┐        ⑤ 按订阅过滤 + 可见性
  │      │   │ ws-broadcaster │
  │  ◄──────┤ ┴ WS send        │
  │      │   └────────────────┘
  │      │
  │      │ ⑥ 断线重连: HTTP GET /api/panel/driver/:id/turns?active=1&recent=20
  │      │   ─────────────────────────────────────────────────────────────►
  │      │                                    ┌──────────────────────────┐
  │      │                                    │ turn-aggregator.         │
  │      │                                    │ getActive(driverId)      │
  │      │                                    │ getRecent(driverId, N)   │
  │      │  ◄────────────────────────────────┤                          │
  │      │   { active: Turn | null,           └──────────────────────────┘
  │      │     recent: Turn[] }
  └──────┘
```

### 4.2 聚合器在哪一层

**独立 bus subscriber**：`packages/backend/src/bus/subscribers/turn-aggregator.subscriber.ts`

- 不动 AgentDriver（driver 只管 ACP ↔ DriverEvent，语义最小）
- 不塞进 ws-broadcaster（broadcaster 职责单一：按订阅过滤 + 转发；加聚合会超 200 行 + 单测变复杂）
- 放 bus subscriber 层：订阅 driver.*，产出 turn.*；和其他 subscriber 平级

### 4.3 聚合器核心状态 + API

```typescript
// turn-aggregator.subscriber.ts
import type { Turn, TurnBlock, UserInput } from '../../agent-driver/turn-types.js';

export interface TurnAggregator {
  /** 取某 driver 的活跃 turn（正在进行中），无则 null */
  getActive(driverId: string): Turn | null;
  /** 取最近 N 条已完成 turn（最新优先） */
  getRecent(driverId: string, limit: number): Turn[];
}

export function subscribeTurnAggregator(
  eventBus: EventBus,
  opts?: { historyPerDriver?: number },   // 默认 50
): { aggregator: TurnAggregator; subscription: Subscription };
```

### 4.4 增量推送规则（block → turn.block_updated）

**每条 driver.* 事件 → 更新对应 Block → emit 一条 `turn.block_updated`（block 完整最新状态，不是 delta）**。

前端收到后按 `block.blockId` 在本地 Turn.blocks 里**替换**对应 block（不存在则 append）。为什么发完整 block 不发 delta：
- 省前端的拼接逻辑（尤其是 content 字符串追加的边界 bug）
- 单 block 一般 ≤ 10KB，WS 带宽不是瓶颈
- 收不到某条时，下一条自带完整状态，自动补齐

### 4.5 Turn 边界判定

**开始**：AgentDriver.prompt() 内部分配 turnId（UUID），在调 conn.prompt 前 emit `driver.turn_start { turnId, userInput }`。聚合器收到后新建 `Turn { status:'active', blocks:[] }`。

**结束（正常）**：AgentDriver 收到 session/prompt 响应后 emit `driver.turn_done { turnId, stopReason, usage? }`。聚合器 → `turn.status='done'`，emit `turn.completed`，把 Turn 从 `active` Map 移到 `history[driverId]`。

**结束（异常 · reviewer A 条）**：
- 聚合器订阅 `driver.error` / `driver.stopped`。如果该 driver 有 active Turn：
  - `driver.error`：Turn.status='error'，stopReason='crashed'，emit `turn.completed` + `turn.error`
  - `driver.stopped`：若还有 active Turn（正常流程应先 turn_done 再 stopped），同上处理避免悬挂
- 保证 active Map 不泄漏内存

### 4.6 历史保留策略

- `history[driverId]`: 环形队列，保留最近 N=50（可配），超出丢最旧
- `driver.stopped` 时：active 清掉，history 保留（给 HTTP 查询；driver 重启后仍可读到历史）
- Hub 进程重启：内存丢失，前端依赖自己 localStorage 缓存（符合 MILESTONE §5.5 方案 X）

**不持久化到 DB**（本期）。理由：
- MILESTONE §5.5 明确说本期 driver.text 零后端持久化
- 聚合器 in-memory 历史 + 前端 localStorage 足够覆盖「刷新当前会话」场景
- 跨设备历史留给 MILESTONE §5.5 方案 Y（独立 `driver_turn_log` 表 + HTTP 翻页）

**已定边界（reviewer 审查后明确写入，防未来再争论）**：Hub 进程重启内存即丢失。本方案在 MILESTONE §5.5 方案 X 基础上**超配**了后端内存 + HTTP 快照（纯前端 localStorage 合流 N 条 block 过于复杂），但**不等价于**方案 Y。需要跨进程 / 跨设备历史时才引入 `driver_turn_log` 表，本期不做。

### 4.7 并发 streaming 的 seq 语义（reviewer G + P3 条）

- thinking / text / tool_call 可**并发 streaming**（agent 边想边说边调工具）
- `block.seq` = **首次出现**时由 aggregator 分配的递增序号，**此后不变**
- `block.updatedTs` = 最后一次更新时间
- 前端按 seq 排序渲染（创建顺序 = 显示顺序），content/toolStatus/output 原地更新，不重排

**每 turn 从 0 重开**（reviewer P3）：聚合器在 `driver.turn_start` 时初始化 `Turn.blocks = []` + 内部 counter=0；第一个 block 拿 seq=0，依次 +1。下一个 turn 又从 0 开始。不跨 turn 累加，前端按 turn 独立排序，简单干净。

### 4.8 HTTP 恢复接口（reviewer F 条）

> **面向**：**前端**（WS 重连时拉快照）。后端实现在 `api/panel/driver-turns.ts`。

`GET /api/panel/driver/:driverId/turns?active=1&recent=N`

响应：
```json
{
  "active": { "turnId": "...", "status": "active", "blocks": [...], ... } /* 或 null */,
  "recent": [ /* Turn[]，最新优先 */ ]
}
```

实现在 `packages/backend/src/api/panel/driver-turns.ts`（新文件），调 `aggregator.getActive` / `getRecent`。前端 WS 重连 → 先拉 HTTP 快照，再订阅 WS 接实时。

**语义明确（reviewer S1）**：
- `active` = 当前 status='active' 的 Turn，无则 `null`（driver 未 prompt 或已 turn_done 清空）
- `recent` = **已 complete/error** 的 Turn 列表，**不含** active；顺序按 `endTs` 降序（新的在前）
- driver 从未跑过（无任何 turn 记录）：响应 `{ active: null, recent: [] }`，**不 404**
- `N` 上限建议 50（等于历史保留上限），超出按上限截断

---

## 5. WS 推送 JSON 示例

> **面向**：**前端**（订阅 `/ws/events` 收到的消息形状）。这些是前端唯一需要实现消费逻辑的事件；`driver.*` 除了 3 条生命周期外**都不推前端**（见 §5.8 白名单）。

### 5.1 Turn 开始 —— 新增 `turn.started` 事件

聚合器收到 `driver.turn_start` 时只新建内部 Turn，**不会**直接产出 `turn.block_updated`（此时无 block）。但前端需要立即切换到「正在思考」loading 态，不能等到第一条 block_updated（可能 1 秒后才到）或等到 `turn.completed`（空 turn 情况下是唯一事件）。因此**新增** WS 事件 `turn.started`，让前端即时收到 turn 开始信号：

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.started",
    "ts": "2026-04-25T12:00:00.100Z",
    "eventId": "evt_01h...",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "userInput": {
      "text": "帮我分析 /tmp/x.txt",
      "ts": "2026-04-25T12:00:00.050Z"
    }
  }
}
```

（对应 bus 事件 `turn.started`，聚合器 driver.turn_start 时 emit）

### 5.2 text block 增量（流式中）

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.block_updated",
    "ts": "2026-04-25T12:00:01.234Z",
    "eventId": "evt_01h...",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "seq": 1,
    "block": {
      "blockId": "msg_01h...",
      "type": "text",
      "scope": "turn",
      "status": "streaming",
      "seq": 1,
      "startTs": "2026-04-25T12:00:00.500Z",
      "updatedTs": "2026-04-25T12:00:01.234Z",
      "messageId": "msg_01h...",
      "content": "我来帮你分析 /tmp/x.txt，先读一下这个文件"
    }
  }
}
```

### 5.3 tool_call block（Codex 形状）

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.block_updated",
    "ts": "2026-04-25T12:00:02.500Z",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "seq": 2,
    "block": {
      "blockId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "type": "tool_call",
      "scope": "turn",
      "status": "streaming",
      "seq": 2,
      "startTs": "2026-04-25T12:00:02.500Z",
      "updatedTs": "2026-04-25T12:00:02.500Z",
      "toolCallId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "title": "Read x.txt",
      "kind": "read",
      "toolStatus": "in_progress",
      "locations": [{ "path": "/tmp/x.txt" }],
      "input": {
        "vendor": "codex",
        "display": "cat /tmp/x.txt",
        "data": {
          "command": ["/opt/homebrew/bin/zsh", "-lc", "cat /tmp/x.txt"],
          "cwd": "/tmp",
          "parsed_cmd": [{ "type": "read", "cmd": "cat /tmp/x.txt", "path": "/tmp/x.txt" }],
          "source": "unified_exec_startup"
        }
      }
    }
  }
}
```

### 5.4 tool_call 完成（update）

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.block_updated",
    "ts": "2026-04-25T12:00:02.780Z",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "seq": 2,
    "block": {
      "blockId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "type": "tool_call",
      "scope": "turn",
      "status": "done",
      "seq": 2,
      "startTs": "2026-04-25T12:00:02.500Z",
      "updatedTs": "2026-04-25T12:00:02.780Z",
      "toolCallId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "title": "Read x.txt",
      "kind": "read",
      "toolStatus": "completed",
      "input": { "vendor": "codex", "display": "cat /tmp/x.txt", "data": { /* 同上 */ } },
      "output": {
        "vendor": "codex",
        "display": "hello world\n",
        "exitCode": 0,
        "data": {
          "stdout": "hello world\n",
          "stderr": "",
          "aggregated_output": "hello world\n",
          "exit_code": 0,
          "duration": { "secs": 0, "nanos": 51935000 },
          "formatted_output": "hello world\n",
          "status": "completed"
        }
      }
    }
  }
}
```

### 5.5 plan block（全量替换）

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.block_updated",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "seq": 3,
    "block": {
      "blockId": "plan-turn_abc123",
      "type": "plan",
      "scope": "turn",
      "status": "streaming",
      "seq": 3,
      "startTs": "2026-04-25T12:00:03.000Z",
      "updatedTs": "2026-04-25T12:00:03.000Z",
      "entries": [
        { "content": "读取文件", "priority": "high", "status": "completed" },
        { "content": "分析内容", "priority": "high", "status": "in_progress" },
        { "content": "输出结论", "priority": "medium", "status": "pending" }
      ]
    }
  }
}
```

### 5.6 usage block

```json
{
  "type": "event",
  "event": {
    "type": "turn.block_updated",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "seq": 4,
    "block": {
      "blockId": "usage-turn_abc123",
      "type": "usage",
      "scope": "turn",
      "status": "done",
      "seq": 4,
      "used": 8284,
      "size": 258400
    }
  }
}
```

### 5.7 Turn 完成

```json
{
  "type": "event",
  "id": "evt_01h...",
  "event": {
    "type": "turn.completed",
    "ts": "2026-04-25T12:00:05.000Z",
    "driverId": "inst_leader_01",
    "turnId": "turn_abc123",
    "turn": {
      "turnId": "turn_abc123",
      "driverId": "inst_leader_01",
      "status": "done",
      "stopReason": "end_turn",
      "startTs": "2026-04-25T12:00:00.100Z",
      "endTs": "2026-04-25T12:00:05.000Z",
      "userInput": { "text": "帮我分析 /tmp/x.txt", "ts": "..." },
      "blocks": [ /* 完整 block 列表 */ ],
      "usage": { "totalTokens": 1234, "inputTokens": 800, "outputTokens": 434 }
    }
  }
}
```

### 5.8 生命周期（仍然单独发 · reviewer C 条）

`driver.started` / `driver.stopped` / `driver.error` **保留**推前端，前端用来渲染「agent 在线/离线/出错」状态栏。其他 `driver.*`（thinking/text/tool_call/tool_update/turn_start/turn_done/plan/commands/mode/config/session_info/usage）**不推前端**，走 turn.* 聚合。

WS 白名单调整（同步改 `bus/subscribers/ws.subscriber.ts`）：

```diff
  'driver.started',
  'driver.stopped',
  'driver.error',
- 'driver.thinking',
- 'driver.text',
- 'driver.tool_call',
- 'driver.tool_result',
- 'driver.turn_done',
+ 'turn.started',
+ 'turn.block_updated',
+ 'turn.completed',
+ 'turn.error',
```

W2-H 守门测试同步更新断言集合。

---

## 6. 前端渲染建议

> **面向**：**前端**。本章节直接给前端开发者参考实现。

### 6.1 状态机

前端（renderer）新建 `store/driverStore.ts`：

```typescript
interface DriverState {
  /** driverId → 当前 turn */
  active: Record<string, Turn | null>;
  /** driverId → 历史 turns（降序，新的在前） */
  history: Record<string, Turn[]>;
  /** driverId → 生命周期状态 */
  lifecycle: Record<string, 'starting' | 'ready' | 'working' | 'stopped' | 'error'>;
}
```

### 6.2 WS 事件处理

| 事件 | 操作 |
|------|------|
| `turn.started` | `active[driverId] = new Turn(with userInput)` |
| `turn.block_updated` | 在 `active[driverId].blocks` 按 `blockId` upsert；若 active 不存在（WS 乱序到达）按 `turnId` 新建 |
| `turn.completed` | `active[driverId] = null`；`history[driverId].unshift(turn)`（限长 50） |
| `turn.error` | active.status='error'，showToast |
| `driver.started` | `lifecycle[driverId] = 'ready'` |
| `driver.stopped` | `lifecycle[driverId] = 'stopped'`；`active[driverId] = null`（强制关闭） |
| `driver.error` | `lifecycle[driverId] = 'error'` |

### 6.3 渲染组件映射（对齐 `ui-component-research.md`）

| Block type | 前端组件 | scope='session' 时位置 |
|-----------|---------|----------------------|
| thinking | `ThinkingBlock`（折叠思考块） | — |
| text | `MessageBubble`（agent 气泡） | — |
| tool_call | `ToolCallCard`（状态+input.display+output.display） | — |
| plan | `PlanCard`（任务清单） | — |
| usage | `UsageBar`（底部 token 条） | — |
| commands | `CommandsPanel`（`/` 命令面板） | 输入框弹层 |
| mode | `ModeIndicator`（顶部模式标签） | 顶栏 |
| config | `ConfigPanel`（设置面板） | 设置抽屉 |
| session_info | `SessionTitle` | 顶栏 |

**渲染顺序**：`Turn.blocks.filter(b => b.scope === 'turn').sort((a,b) => a.seq - b.seq)` 在正文区顺序渲染；`scope === 'session'` 的 block 广播给顶栏/设置等组件。

### 6.4 vendor-aware 渲染

工具卡片默认只渲 `input.display` / `output.display`（人类可读）。点「展开原始」时根据 `input.vendor` 选组件：

- `vendor === 'codex'`: 展开 `data.command` / `data.parsed_cmd`，output 展开 `data.stdout` / `data.stderr` / `data.exit_code` / `data.duration`
- `vendor === 'claude'`: 展开 `data` 的工具原生参数字典和原生返回值

两套渲染组件（`CodexToolDetails` / `ClaudeToolDetails`），由 `input.vendor` 决定。90% 用户看不到，接入成本低。

### 6.5 断线重连

```typescript
async function onWsReconnect() {
  const driverId = currentDriverId;
  const snapshot = await http.get(`/api/panel/driver/${driverId}/turns?active=1&recent=20`);
  store.active[driverId] = snapshot.active;
  store.history[driverId] = snapshot.recent;
  ws.send({ op: 'subscribe', scope: 'instance', id: driverId, lastMsgId: lastSeenEventId });
}
```

HTTP 拉快照 → 再订阅 WS；`lastMsgId` 让后端走 gap-replay（对 comm.* 有效；turn.* 瞬时不补发，HTTP 已覆盖）。

---

## 7. 模块拆分建议

> **面向**：**后端实现者**（§7.1~§7.3）+ **前端实现者**（§7.4）。§7.4 明确标出前端文件位置，其余为后端。

### 7.1 非业务（纯类型/工具）

| 模块 | 位置 | 职责 | 估行 |
|------|------|------|------|
| turn-types.ts | `agent-driver/turn-types.ts` | Turn/TurnBlock/Vendor 等所有数据类型 | ≤ 200 |
| normalize.ts | `agent-driver/adapters/normalize.ts` | ACP 原始值 → 我们的 AcpContent/Location/PlanEntry 等纯转换 | ≤ 200 |

**禁止 import**：`bus/*`、`comm/*`、`ws/*`、`filter/*`。只 import `node:*` + 本目录同级类型。

### 7.2 业务胶水

| 模块 | 位置 | 职责 | 估行 |
|------|------|------|------|
| claude.ts | `agent-driver/adapters/claude.ts` | ClaudeAdapter + 厂商 display 提取 | ≤ 180 |
| codex.ts | `agent-driver/adapters/codex.ts` | CodexAdapter + 厂商 display 提取 | ≤ 200 |
| types.ts | `agent-driver/types.ts` | DriverEvent 联合（import turn-types） | ≤ 150 |
| driver.ts | `agent-driver/driver.ts` | 新增 turn_start emit + turnId 分配 | 现有 +20 |
| bus-bridge.ts | `agent-driver/bus-bridge.ts` | DriverEvent → BusEvent 翻译（新增 7 事件） | ≤ 180 |
| turn-aggregator.subscriber.ts | `bus/subscribers/turn-aggregator.subscriber.ts` | 核心聚合器（in-memory Turn Map + 产出 turn.*） | ≤ 250（超则拆 store 出去） |
| driver-turns.ts | `api/panel/driver-turns.ts` | HTTP GET /panel/driver/:id/turns | ≤ 120 |

**拆分时机（reviewer Q3）**：本期 turn-aggregator 先单文件写，**不提前拆**（避免 premature abstraction）。实现时若发现 ≥ 200 行，再拆成 `turn-store.ts`（纯存储：getActive/getRecent/upsert/close）+ `turn-aggregator.subscriber.ts`（订阅 bus → 调 store → emit turn.*）。这样职责边界清晰：store 不碰 bus，subscriber 只做事件翻译。

### 7.3 bus 事件定义

| 模块 | 改动 |
|------|------|
| bus/types.ts | DriverToolResultEvent → DriverToolUpdateEvent；新增 7 driver.* 事件类型；新增 4 turn.* 事件类型 |
| bus/subscribers/ws.subscriber.ts | 白名单调整：去除除 started/stopped/error 外的 driver.*；加 turn.* 四条 |
| bus/index.ts | bootSubscribers 注册 subscribeTurnAggregator |

### 7.4 前端

| 模块 | 位置 | 备注 |
|------|------|------|
| turn-types.ts | `renderer/types/turn.ts` | 从后端 turn-types 复制（或走 workspace 共享包，本期复制） |
| driverStore.ts | `renderer/store/driverStore.ts` | active / history / lifecycle |
| 组件 | `renderer/molecules/TurnBlock*.tsx` | 按 block.type 分别实现 |

**技术债记账（reviewer S2）**：前端 `turn-types.ts` 本期走**手动复制**是过渡方案。phase-ws 前端接入（或下一期）评估抽 `@mteam/shared-types` workspace 包（bun workspace 已有 packages 结构，改造成本低）。记一条 TODO，不在本方案 scope 里。

---

## 8. 任务拆分建议（实施时参考）

建议按 phase-ws Wave 模式拆，**强烈建议插队到 Wave 1 执行**（现在改，W2 的 ws-broadcaster 就能拿到 turn.* 成果一起上线）：

| # | 任务 | 类型 | 前置 | 估时 |
|---|------|------|------|------|
| T-1 | `turn-types.ts`（纯类型） | 非业务 | — | 0.3d |
| T-2 | `normalize.ts`（纯工具） | 非业务 | T-1 | 0.3d |
| T-3 | `types.ts` DriverEvent 扩展 | 非业务 | T-1 | 0.2d |
| T-4 | ClaudeAdapter 补全 | 业务 | T-1/T-2/T-3 | 0.6d |
| T-5 | CodexAdapter 补全 | 业务 | T-1/T-2/T-3 | 0.6d |
| T-6 | driver.ts 加 turn_start emit | 业务 | T-3 | 0.2d |
| T-7 | bus/types.ts + helpers 新增 7 driver + 4 turn 事件 | 业务 | T-1 | 0.3d |
| T-8 | bus-bridge.ts 翻译扩展 | 业务 | T-3/T-7 | 0.3d |
| T-9 | `turn-aggregator.subscriber.ts`（核心） | 业务 | T-7 | 0.8d |
| T-10 | `driver-turns.ts` HTTP 接口 | 业务 | T-9 | 0.3d |
| T-11 | ws.subscriber.ts 白名单调整 + W2-H 断言更新 | 业务 | T-7 | 0.2d |
| T-12 | 回归测试 | 测试 | 所有 | 0.5d |

合计 **≈ 4.6 人日**。可并行：T-2/T-3 同时；T-4/T-5 同时。

**T-11 时序硬约束（reviewer P2 · 不可并行 T-9）**：

T-11（白名单切换：关 driver.thinking/text/tool_call/tool_update/turn_done，开 turn.*）**必须晚于 T-9 merge**。

反例（禁止）：T-11 先上 → turn-aggregator 还没跑 → **前端本 turn 丢所有 thinking/text/tool_call**，用户对着黑屏看。

正序（推荐）：
1. **Stage 1**：T-9 聚合器 merge；此时 bus 上同时流着 driver.* 和 turn.*（双写期）
2. **Stage 2**：T-11 白名单切换 merge；driver.thinking/text/tool_call/tool_update/turn_done 从 WS 白名单摘掉，只推 turn.*

双写期前端会短暂同时收到 driver.* 和 turn.*（重复但不缺），比丢事件好。双写时长控制在同一个 release window 内，Stage 1/2 不必拆成两个发布。

如果必须做 feature flag：T-9 加环境变量 `TURN_AGGREGATOR_ENABLED`（默认 true），紧急 rollback 时关聚合器 + 还原白名单。

**与 phase-ws 主干关系**：
- T-1 ~ T-8 不依赖 phase-ws Wave 1/2，可提前
- T-9 不依赖 ws-broadcaster（只依赖 bus）
- T-11 会冲突 W2-H 的测试 —— 建议打在 phase-ws 同一 PR 或紧挨着 merge，且遵守 T-9 → T-11 顺序
- T-10 HTTP 接口不依赖 W2-1

**已知缺口（reviewer S4，不 blocking 本方案）**：`driver.ts:95` 的 `requestPermission` 当前永远 `cancelled`。本方案不涉及用户授权 UI，但工具调用「等待用户批准」这条路径是空白的 —— 未来给 tool_call 加 `pending_permission` 中间态（前端弹确认框 → 上行 permission_response → 后端 resolve 回 ACP）时要补。此处只记账，本期不做。

---

## 9. 关键决策摘要（对抗纪要）

| 决策点 | 结论 | 提出人 |
|-------|------|--------|
| Turn 边界 | driver.prompt() 内 emit turn_start（不依赖 prompt response）+ driver.stopped/error 强制关闭保险 | architect-turn + reviewer-turn A |
| vendor tag 位置 | input/output 内部，并强制 adapter 提取 display 归一化字符串 | reviewer-turn B |
| driver.* 是否推前端 | 只保留 started/stopped/error（生命周期），其他走 turn.* 聚合 | reviewer-turn C |
| tool_result 改名 | 一次改到位成 tool_update（不加新废旧） | reviewer-turn D |
| plan/usage/commands 分层 | 不拆两层，统一 Turn.blocks + block.scope='turn'|'session' | reviewer-turn E |
| 聚合器持久化 | in-memory + 环形历史 50 条 + HTTP 快照接口，不落 DB | reviewer-turn F |
| block.seq 语义 | 首次出现时分配的创建序号，不变；updatedTs 表更新时间 | reviewer-turn G |
| adapter 行数 | 单文件 ≤ 250 红线；normalize.ts 抽出 | reviewer-turn H |
| Turn.userInput | Turn 里带 userInput，driver.prompt() 注入 | reviewer-turn I |
| 新增 turn.started 事件 | 让前端即时知道 turn 开始（不等 block_updated） | architect-turn 补 |
| HTTP 接口路径 | `/api/panel/driver/:driverId/turns?active=1&recent=N` | reviewer-turn F |
| AcpContent 过滤类型守卫 | normalize.ts 出 `compactAcpContent`，禁用裸 `filter(Boolean)` | reviewer-turn P1 |
| T-11 时序 | 必须晚于 T-9 merge，双写期过渡 | reviewer-turn P2 |
| seq 每 turn 重开 | 每 turn counter 从 0 起，不跨 turn 累加 | reviewer-turn P3 |
| TurnUsage vs UsageBlock 语义 | 前者 turn 结束账单（仅 Claude 有），后者 context 进度条（两家都发）；可共存分别渲染 | reviewer-turn S3 |

---

## 10. 验收清单（实施后对照）

- [ ] `agent-driver/turn-types.ts` 存在；9 种 Block + Turn + UserInput 完整 TS 定义
- [ ] ClaudeAdapter 覆盖 11 种 sessionUpdate（含 plan/commands/mode/config/session_info/usage）
- [ ] CodexAdapter 覆盖 11 种 sessionUpdate
- [ ] adapter 填充 `input.display` / `output.display` / `output.exitCode`
- [ ] DriverEvent 12 种（含 turn_start/turn_done/tool_update 改名）
- [ ] driver.ts prompt() 前 emit turn_start，后 emit turn_done（带 turnId）
- [ ] bus-bridge.ts 翻译所有 12 种
- [ ] `bus/subscribers/turn-aggregator.subscriber.ts` 产出 turn.started / turn.block_updated / turn.completed / turn.error
- [ ] 聚合器能处理 driver.error/stopped 强制关闭 active Turn
- [ ] HTTP `GET /api/panel/driver/:id/turns?active=1&recent=N` 可用
- [ ] WS 白名单调整：driver.* 只留 3 条生命周期；新增 turn.* 4 条
- [ ] W2-H 守门测试更新
- [ ] 每个新文件 ≤ 200 行；adapters 红线 250
- [ ] 每个新模块有 `*.test.ts`（不 mock db/bus）
- [ ] 每个新模块有 `README.md`（按 phase-ws 习惯）
- [ ] 前端 driverStore + turn 组件（本期可延后到 phase-ws 前端接入）

---

## 11. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版骨架 | architect-turn |
| 2026-04-25 | reviewer-turn A/B/C/D/E/F/G/H/I 反馈全部采纳并落到正式方案 | architect-turn |
| 2026-04-25 | reviewer-turn 终审反馈 P1/P2/P3 必补丁 + S1/S3 小议落地；S2/S4 作为已知技术债记账；Q1~Q3 追问结论写入 §4.6/§5.1/§7.2；**方案终稿** | architect-turn |
