// Turn / TurnBlock 数据模型。纯类型 + 类型守卫，零业务依赖。
// 服务端 agent-driver / bus / ws-broadcaster 和前端共用这套形状。
// 权威合约见 docs/phase-ws/turn-aggregator-design.md §1.2 / §1.3。

export type TurnBlockType =
  | 'thinking' | 'text' | 'tool_call' | 'plan' | 'usage'
  | 'commands' | 'mode' | 'config' | 'session_info';

export type BlockScope = 'turn' | 'session';
export type BlockStatus = 'streaming' | 'done' | 'error';
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

// adapter 必须填 display（人类可读短串）；data 透传原始 rawInput/rawOutput。
export interface VendorPayload {
  vendor: Vendor;
  display: string;
  data: unknown;
}

export interface VendorOutput extends VendorPayload {
  exitCode?: number;
}

// ---------- Block ----------

export interface TurnBlockBase {
  blockId: string;
  type: TurnBlockType;
  scope: BlockScope;
  status: BlockStatus;
  // 本 turn 内单调递增，首次出现时分配；此后不变。前端按 seq 定位，content 原地更新。
  seq: number;
  startTs: string;
  updatedTs: string;
}

export interface ThinkingBlock extends TurnBlockBase {
  type: 'thinking'; scope: 'turn'; messageId?: string; content: string;
}

export interface TextBlock extends TurnBlockBase {
  type: 'text'; scope: 'turn'; messageId?: string; content: string;
}

export interface ToolCallBlock extends TurnBlockBase {
  type: 'tool_call';
  scope: 'turn';
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  toolStatus: ToolStatus;
  locations?: Location[];
  input: VendorPayload;
  output?: VendorOutput;
  content?: AcpContent[];
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanBlock extends TurnBlockBase {
  type: 'plan'; scope: 'turn'; entries: PlanEntry[];
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
  type: 'commands'; scope: 'session'; commands: CommandDescriptor[];
}

export interface ModeBlock extends TurnBlockBase {
  type: 'mode'; scope: 'session'; currentModeId: string;
}

export interface ConfigOption {
  id: string;
  category: 'mode' | 'model' | 'thought_level';
  type: 'select' | 'toggle' | 'text';
  currentValue: string | number | boolean;
  options?: Array<{ id: string; name: string; description?: string }>;
}

export interface ConfigBlock extends TurnBlockBase {
  type: 'config'; scope: 'session'; options: ConfigOption[];
}

export interface SessionInfoBlock extends TurnBlockBase {
  type: 'session_info'; scope: 'session'; title?: string; updatedAt?: string;
}

export type TurnBlock =
  | ThinkingBlock | TextBlock | ToolCallBlock
  | PlanBlock | UsageBlock
  | CommandsBlock | ModeBlock | ConfigBlock | SessionInfoBlock;

// ---------- Turn ----------

export type TurnStatus = 'active' | 'done' | 'error';

// 'crashed' 专供 driver.error/stopped 强制关闭 active Turn 时兜底（reviewer A）。
export type StopReason =
  | 'end_turn' | 'max_tokens' | 'max_turn_requests'
  | 'refusal' | 'cancelled' | 'crashed';

// session/prompt 响应里的 token 细分（Claude 有，Codex 无）；与 usage_update 事件（UsageBlock）粒度不同。
export interface TurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface UserInput {
  text: string;
  attachments?: AcpContent[];
  ts: string;
}

export interface Turn {
  turnId: string;
  driverId: string;
  status: TurnStatus;
  userInput: UserInput;
  blocks: TurnBlock[];
  stopReason?: StopReason;
  usage?: TurnUsage;
  startTs: string;
  endTs?: string;
}

// ---------- 类型守卫 ----------

const TURN_BLOCK_TYPES: readonly TurnBlockType[] = [
  'thinking', 'text', 'tool_call', 'plan', 'usage',
  'commands', 'mode', 'config', 'session_info',
];

const SESSION_SCOPE_TYPES: ReadonlySet<TurnBlockType> = new Set([
  'commands', 'mode', 'config', 'session_info',
]);

export function isTurnBlockType(v: unknown): v is TurnBlockType {
  return typeof v === 'string' && (TURN_BLOCK_TYPES as readonly string[]).includes(v);
}

export function isSessionScopeBlock(block: TurnBlock): boolean {
  return SESSION_SCOPE_TYPES.has(block.type);
}

export const isThinkingBlock = (b: TurnBlock): b is ThinkingBlock => b.type === 'thinking';
export const isTextBlock = (b: TurnBlock): b is TextBlock => b.type === 'text';
export const isToolCallBlock = (b: TurnBlock): b is ToolCallBlock => b.type === 'tool_call';
export const isPlanBlock = (b: TurnBlock): b is PlanBlock => b.type === 'plan';
export const isUsageBlock = (b: TurnBlock): b is UsageBlock => b.type === 'usage';
export const isCommandsBlock = (b: TurnBlock): b is CommandsBlock => b.type === 'commands';
export const isModeBlock = (b: TurnBlock): b is ModeBlock => b.type === 'mode';
export const isConfigBlock = (b: TurnBlock): b is ConfigBlock => b.type === 'config';
export const isSessionInfoBlock = (b: TurnBlock): b is SessionInfoBlock => b.type === 'session_info';
