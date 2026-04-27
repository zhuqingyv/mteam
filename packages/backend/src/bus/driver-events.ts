// bus 侧 driver.* 事件形状。T-7 按事件域从 types.ts 拆出；消费方继续 import '../bus/types.js'。
// 过渡期：tool_result / 老 turn_done 形状保留；新增 tool_update / turn_start 等并存。
// 权威合约见 docs/phase-ws/turn-aggregator-design.md §2.4。

import type { BusEventBase } from './types.js';

// ---------- 生命周期（不变） ----------

export interface DriverStartedEvent extends BusEventBase {
  type: 'driver.started';
  driverId: string;
  // Stage 3 W2-1c：driver 起来后带上 runtime pid，供 pid-writeback 订阅写回
  // role_instances.session_pid。host 模式下为 number；容器化场景可能是 string；
  // 某些极端失败路径 RuntimeHandle 没 pid，字段整体省略。
  pid?: number | string;
}

export interface DriverStoppedEvent extends BusEventBase {
  type: 'driver.stopped';
  driverId: string;
}

export interface DriverErrorEvent extends BusEventBase {
  type: 'driver.error';
  driverId: string;
  message: string;
}

// ---------- chunk 类（扩 messageId） ----------

export interface DriverThinkingEvent extends BusEventBase {
  type: 'driver.thinking';
  driverId: string;
  content: string;
  // T-8：turn-aggregator 按 messageId 合并同一 messageId 的 thinking 增量为一个 Block。
  messageId?: string;
}

export interface DriverTextEvent extends BusEventBase {
  type: 'driver.text';
  driverId: string;
  content: string;
  // T-8：同上，turn-aggregator 按 messageId 合并增量；老消费方（log/domain-sync）对该字段无依赖。
  messageId?: string;
}

// ---------- tool_call（扩字段，老 name 保留） ----------

// T-8：tool_call 原本只带 name + 入参字典。设计文档 §2.2 要求补 toolCallId / title /
// kind / status / locations / input(VendorPayload) / content(AcpContent[])；过渡期老字段 name
// 保留必填（policy.subscriber 等消费方靠它识别工具名），新增字段全可选，直到 T-11 裁撤。
export interface DriverToolCallEvent extends BusEventBase {
  type: 'driver.tool_call';
  driverId: string;
  /** @deprecated 过渡期老字段；新 adapter 填 `title || 'tool'`，T-11 后由架构师清理 */
  name: string;
  /** 终态入参；过渡期也允许 adapter 以 VendorPayload 形状写进来。消费方按需断言。 */
  input: Record<string, unknown>;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number }>;
  content?: unknown[];
}

/** @deprecated T-11 裁撤；由 driver.tool_update 取代。保留到白名单切换完毕。 */
export interface DriverToolResultEvent extends BusEventBase {
  type: 'driver.tool_result';
  driverId: string;
}

// T-8：tool_call_update（中间态 + 终态合并），设计文档 §2.2。toolCallId 必填，其他字段 ACP
// 语义是"本次更新带什么就覆盖什么"，前端在聚合器里按 toolCallId upsert。
export interface DriverToolUpdateEvent extends BusEventBase {
  type: 'driver.tool_update';
  driverId: string;
  toolCallId: string;
  status?: string;
  title?: string;
  kind?: string;
  locations?: Array<{ path: string; line?: number }>;
  output?: { vendor: string; display: string; data: unknown; exitCode?: number };
  content?: unknown[];
}

// ---------- plan / commands / mode / config / session_info / usage ----------

// T-8：plan sessionUpdate → 全量替换本 turn 的 plan entries。
export interface DriverPlanEvent extends BusEventBase {
  type: 'driver.plan';
  driverId: string;
  entries: Array<{
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
  }>;
}

// T-8：available_commands_update → 会话级 slash-command 列表。
export interface DriverCommandsEvent extends BusEventBase {
  type: 'driver.commands';
  driverId: string;
  commands: Array<{ name: string; description: string; inputHint?: string }>;
}

// T-8：current_mode_update → 会话级模式切换。
// 命名差异（T-7 记账）：team-lead 派发 T-7 用 `driver.mode_change`，本实现用 `driver.mode`
// 对齐设计文档 §2.2 + agent-driver/types.ts DriverModeEvent 字面量。二选一需由架构师裁决，
// 当前保持与 driver 侧一致以免 bus-bridge（T-8）翻译时字面量对不上。
export interface DriverModeEvent extends BusEventBase {
  type: 'driver.mode';
  driverId: string;
  currentModeId: string;
}

// T-8：config_option_update → 会话级配置项。命名与 driver.mode 同理保留 `driver.config`。
export interface DriverConfigEvent extends BusEventBase {
  type: 'driver.config';
  driverId: string;
  options: Array<{
    id: string;
    category: 'mode' | 'model' | 'thought_level';
    type: 'select' | 'toggle' | 'text';
    currentValue: string | number | boolean;
    options?: Array<{ id: string; name: string; description?: string }>;
  }>;
}

// T-8：session_info_update → 会话级标题等。title/updatedAt 都可选（adapter 只填有的字段）。
export interface DriverSessionInfoEvent extends BusEventBase {
  type: 'driver.session_info';
  driverId: string;
  title?: string;
  updatedAt?: string;
}

// T-8：usage_update → context window 进度（两家都发）；与 turn_done.usage 语义不同，见设计 §1.2。
export interface DriverUsageEvent extends BusEventBase {
  type: 'driver.usage';
  driverId: string;
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

// ---------- turn_start / turn_done（turn 边界） ----------

// T-8：driver.prompt() 内分配 turnId 后 emit；携带 userInput 让聚合器能把用户气泡挂到 Turn 上。
export interface DriverTurnStartEvent extends BusEventBase {
  type: 'driver.turn_start';
  driverId: string;
  turnId: string;
  userInput: {
    text: string;
    attachments?: unknown[];
    ts: string;
  };
}

// T-8：turn_done 扩字段。过渡期 turnId/stopReason/usage 全可选，避免破坏老测试
// （bus-bridge.test.ts 只传 stopReason:'end_turn'，bus 上历史事件不带 turnId）。
export interface DriverTurnDoneEvent extends BusEventBase {
  type: 'driver.turn_done';
  driverId: string;
  turnId?: string;
  stopReason?: string;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
}

// ---------- 驱动事件联合 ----------

export type DriverBusEvent =
  | DriverStartedEvent
  | DriverStoppedEvent
  | DriverErrorEvent
  | DriverThinkingEvent
  | DriverTextEvent
  | DriverToolCallEvent
  | DriverToolResultEvent
  | DriverToolUpdateEvent
  | DriverPlanEvent
  | DriverCommandsEvent
  | DriverModeEvent
  | DriverConfigEvent
  | DriverSessionInfoEvent
  | DriverUsageEvent
  | DriverTurnStartEvent
  | DriverTurnDoneEvent;

export type DriverBusEventType = DriverBusEvent['type'];
