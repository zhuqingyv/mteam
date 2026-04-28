// AgentDriver 公共类型。保持 bus 无关、业务无关，只描述"怎么跑一个 ACP agent"。
// DriverEvent 是驱动层内部统一事件模型，driver.ts 把它翻译成 bus.BusEvent 再 emit。
//
// T-3 扩展：从 5 种扩到 12 种，覆盖 ACP 11 种 sessionUpdate + Turn 边界事件。
// 权威合约见 docs/phase-ws/turn-aggregator-design.md §2.2 / §2.3。
//
// 过渡期说明（T-3 方案 A · team-lead 裁决）：
//   tool_call 保留老字段 name；tool_result 保留不动；同时新增 tool_update（终态形状）。
//   T-4/T-5 adapter 迁移落地后，由架构师统一清理老形状。

import type {
  ToolKind,
  ToolStatus,
  Location,
  AcpContent,
  PlanEntry,
  CommandDescriptor,
  ConfigOption,
  TurnUsage,
  StopReason,
  VendorPayload,
  VendorOutput,
  UserInput,
} from './turn-types.js';

export type DriverStatus = 'IDLE' | 'STARTING' | 'READY' | 'WORKING' | 'STOPPED';

export type AgentType = 'claude' | 'codex' | 'qwen';

export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export type PermissionMode = 'auto' | 'manual';

/** manual 模式下权限请求透传给前端的载荷。通过注入回调传出，不直接 import WS 模块。 */
export interface DriverPermissionRequest {
  instanceId: string;
  requestId: string;
  toolCall: { name: string; input?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface DriverConfig {
  agentType: AgentType;
  systemPrompt: string;
  mcpServers: McpServerSpec[];
  cwd: string;
  env?: Record<string, string>;
  /** W2-6：单次 prompt 超时；默认 2 分钟。测试用更短值触发超时路径。 */
  promptTimeoutMs?: number;
  /** 权限审批模式：'auto'=自动选 options[0]（全自动）；'manual'=透传前端用户决策。默认 'auto'。 */
  permissionMode?: PermissionMode;
  /** manual 模式下 driver 通过此回调把权限请求推出去（WS 广播由外层接入）。 */
  onPermissionRequest?: (req: DriverPermissionRequest) => void;
}

// ---------- DriverEvent 联合（12 种）----------

// driver.thinking —— agent_thought_chunk
export interface DriverThinkingEvent {
  type: 'driver.thinking';
  messageId?: string;
  content: string;
}

// driver.text —— agent_message_chunk
export interface DriverTextEvent {
  type: 'driver.text';
  messageId?: string;
  content: string;
}

// driver.tool_call —— tool_call
// 过渡期：name 保持必填（老 adapter 和 bus-bridge 都依赖），新 adapter 过渡期也填
// `name: title ?? 'tool'`；T-4/T-5 adapter 迁移后由架构师统一删 name 字段。
// title/status/kind/locations/content 为终态字段；input 类型为 unknown（老 adapter 传
// 原始对象；新 adapter 传 VendorPayload，后者对 unknown 赋值兼容）。
export interface DriverToolCallEvent {
  type: 'driver.tool_call';
  toolCallId: string;
  /** @deprecated 老字段，T-4/T-5 adapter 迁移后由架构师统一清理 */
  name: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  locations?: Location[];
  input: unknown | VendorPayload;
  content?: AcpContent[];
}

// driver.tool_result —— 过渡期保留；T-4/T-5 迁移完毕后删除
/** @deprecated 由 driver.tool_update 取代；T-4/T-5 adapter 迁移后由架构师清理 */
export interface DriverToolResultEvent {
  type: 'driver.tool_result';
  toolCallId: string;
  output: unknown;
  ok: boolean;
}

// driver.tool_update —— tool_call_update（终态，中间态 + 终态合并）
export interface DriverToolUpdateEvent {
  type: 'driver.tool_update';
  toolCallId: string;
  status?: ToolStatus;
  title?: string;
  kind?: ToolKind;
  locations?: Location[];
  output?: VendorOutput;
  content?: AcpContent[];
}

// driver.plan —— plan
export interface DriverPlanEvent {
  type: 'driver.plan';
  entries: PlanEntry[];
}

// driver.commands —— available_commands_update
export interface DriverCommandsEvent {
  type: 'driver.commands';
  commands: CommandDescriptor[];
}

// driver.mode —— current_mode_update
export interface DriverModeEvent {
  type: 'driver.mode';
  currentModeId: string;
}

// driver.config —— config_option_update
export interface DriverConfigEvent {
  type: 'driver.config';
  options: ConfigOption[];
}

// driver.session_info —— session_info_update
export interface DriverSessionInfoEvent {
  type: 'driver.session_info';
  title?: string;
  updatedAt?: string;
}

// driver.usage —— usage_update（两家都发，context 进度条粒度）
export interface DriverUsageEvent {
  type: 'driver.usage';
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

// driver.turn_start —— driver.prompt() 前由 driver.ts 分配 turnId 并 emit
export interface DriverTurnStartEvent {
  type: 'driver.turn_start';
  turnId: string;
  userInput: UserInput;
}

// driver.turn_done —— session/prompt 响应后 emit；usage 仅 Claude 响应带
// 过渡期 stopReason 放宽为 string：设计文档定义 StopReason 联合，但老代码（bus-bridge.test.ts）
// 直接传 'end_turn' 字符串。联合 string 不收窄枚举但满足 tsc 与过渡兼容；turnId 过渡期可选。
export interface DriverTurnDoneEvent {
  type: 'driver.turn_done';
  turnId?: string;
  stopReason: StopReason | string;
  usage?: TurnUsage;
}

// 驱动层对外的"语义事件"。driver.ts 负责加 driverId + 时间戳 + 映射到 bus 事件。
export type DriverEvent =
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

// ---------- 类型守卫（便于消费方收窄）----------

export type DriverEventType = DriverEvent['type'];

const DRIVER_EVENT_TYPES: ReadonlySet<string> = new Set<DriverEventType>([
  'driver.thinking',
  'driver.text',
  'driver.tool_call',
  'driver.tool_result',
  'driver.tool_update',
  'driver.plan',
  'driver.commands',
  'driver.mode',
  'driver.config',
  'driver.session_info',
  'driver.usage',
  'driver.turn_start',
  'driver.turn_done',
]);

export function isDriverEvent(x: unknown): x is DriverEvent {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return typeof t === 'string' && DRIVER_EVENT_TYPES.has(t);
}
