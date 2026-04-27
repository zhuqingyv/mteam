// ACP 原始载荷 → turn-types 归一形状。零 bus/db 依赖。合约见 turn-aggregator-design.md §3.1。
import type {
  AcpContent, CommandDescriptor, ConfigOption, Location, PlanEntry,
  ToolKind, ToolStatus, Vendor, VendorOutput, VendorPayload,
} from './turn-types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object';
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ACP ContentBlock：text / image / audio / resource_link / resource。吸收前 4 种。
export function contentBlockToAcpContent(cb: unknown): AcpContent | null {
  if (!isObj(cb)) return null;
  switch (cb.type) {
    case 'text':
      return typeof cb.text === 'string' ? { kind: 'text', text: cb.text } : null;
    case 'image':
    case 'audio': {
      const data = str(cb.data), mimeType = str(cb.mimeType);
      return data && mimeType ? { kind: cb.type, data, mimeType } : null;
    }
    case 'resource_link': {
      const uri = str(cb.uri), name = str(cb.name);
      if (!uri || !name) return null;
      const link: AcpContent = { kind: 'resource_link', uri, name };
      const mimeType = str(cb.mimeType);
      if (mimeType) link.mimeType = mimeType;
      return link;
    }
    default: return null;
  }
}

// ACP ToolCallContent：{type:'content'} | {type:'diff'} | {type:'terminal'}。
export function toolCallContentToAcpContent(tcc: unknown): AcpContent | null {
  if (!isObj(tcc)) return null;
  switch (tcc.type) {
    case 'content': return contentBlockToAcpContent(tcc.content);
    case 'diff': {
      const path = str(tcc.path), newText = str(tcc.newText);
      if (!path || newText === undefined) return null;
      const diff: AcpContent = { kind: 'diff', path, newText };
      const oldText = str(tcc.oldText);
      if (oldText !== undefined) diff.oldText = oldText;
      return diff;
    }
    case 'terminal': {
      const terminalId = str(tcc.terminalId);
      return terminalId ? { kind: 'terminal', terminalId } : null;
    }
    default: return null;
  }
}

// 类型守卫过滤替代裸 filter(Boolean)（reviewer P1：TS 不窄化 (T|null)[] → T[]）。
export function compactAcpContent(raw: unknown): AcpContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(toolCallContentToAcpContent).filter((c): c is AcpContent => c !== null);
}

// sessionUpdate.content 可能是单 ContentBlock 或数组；非 text 块忽略。
export function extractContentText(content: unknown): string {
  if (!content) return '';
  if (Array.isArray(content)) return content.map(extractContentText).join('');
  if (isObj(content) && content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

const PLAN_PRIORITY = new Set(['high', 'medium', 'low']);
const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

export function normalizePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanEntry[] = [];
  for (const item of raw) {
    if (!isObj(item) || typeof item.content !== 'string') continue;
    out.push({
      content: item.content,
      priority: PLAN_PRIORITY.has(item.priority as string) ? (item.priority as PlanEntry['priority']) : 'medium',
      status: PLAN_STATUS.has(item.status as string) ? (item.status as PlanEntry['status']) : 'pending',
    });
  }
  return out;
}

export function normalizeCommands(raw: unknown): CommandDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandDescriptor[] = [];
  for (const item of raw) {
    if (!isObj(item) || typeof item.name !== 'string') continue;
    const cmd: CommandDescriptor = {
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
    };
    const hint = str(item.inputHint);
    if (hint) cmd.inputHint = hint;
    out.push(cmd);
  }
  return out;
}

const CFG_CATEGORY = new Set(['mode', 'model', 'thought_level']);
const CFG_TYPE = new Set(['select', 'toggle', 'text']);
type ConfigChoice = NonNullable<ConfigOption['options']>[number];

export function normalizeConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const item of raw) {
    if (!isObj(item) || typeof item.id !== 'string') continue;
    if (!CFG_CATEGORY.has(item.category as string) || !CFG_TYPE.has(item.type as string)) continue;
    const val = item.currentValue;
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue;
    const opt: ConfigOption = {
      id: item.id,
      category: item.category as ConfigOption['category'],
      type: item.type as ConfigOption['type'],
      currentValue: val,
    };
    if (Array.isArray(item.options)) {
      opt.options = item.options.map(normalizeConfigChoice).filter((c): c is ConfigChoice => c !== null);
    }
    out.push(opt);
  }
  return out;
}

function normalizeConfigChoice(raw: unknown): ConfigChoice | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id), name = str(raw.name);
  if (!id || !name) return null;
  const choice: ConfigChoice = { id, name };
  const desc = str(raw.description);
  if (desc) choice.description = desc;
  return choice;
}

export function normalizeLocations(raw: unknown): Location[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Location[] = [];
  for (const item of raw) {
    if (!isObj(item) || typeof item.path !== 'string') continue;
    const loc: Location = { path: item.path };
    if (typeof item.line === 'number') loc.line = item.line;
    out.push(loc);
  }
  return out.length > 0 ? out : undefined;
}

const TOOL_KINDS = new Set<ToolKind>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);
const TOOL_STATUSES = new Set<ToolStatus>(['pending', 'in_progress', 'completed', 'failed']);

export const mapToolKind = (raw: unknown): ToolKind | undefined =>
  typeof raw === 'string' && TOOL_KINDS.has(raw as ToolKind) ? (raw as ToolKind) : undefined;
export const mapToolStatus = (raw: unknown): ToolStatus =>
  typeof raw === 'string' && TOOL_STATUSES.has(raw as ToolStatus) ? (raw as ToolStatus) : 'pending';

// VendorPayload：display 为人类可读短串，data 透传原始 vendor 形状。
export function normalizeToolInput(vendor: Vendor, title: string, rawInput: unknown): VendorPayload {
  const display = vendor === 'codex' ? describeCodexInput(title, rawInput) : describeClaudeInput(title, rawInput);
  return { vendor, display, data: rawInput ?? null };
}

export function normalizeToolOutput(vendor: Vendor, rawOutput: unknown): VendorOutput {
  if (vendor === 'codex') {
    const out: VendorOutput = { vendor, display: describeCodexOutput(rawOutput), data: rawOutput ?? null };
    if (isObj(rawOutput) && typeof rawOutput.exit_code === 'number') out.exitCode = rawOutput.exit_code;
    return out;
  }
  return { vendor, display: describeClaudeOutput(rawOutput), data: rawOutput ?? null };
}

function describeClaudeInput(title: string, raw: unknown): string {
  if (!isObj(raw)) return title;
  const k = str(raw.file_path) ?? str(raw.command) ?? str(raw.path);
  return k ? (title ? `${title}: ${k}` : k) : title;
}
function describeClaudeOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  return isObj(raw) && typeof raw.content === 'string' ? raw.content : '';
}
function describeCodexInput(title: string, raw: unknown): string {
  if (!isObj(raw)) return title;
  if (Array.isArray(raw.parsed_cmd) && isObj(raw.parsed_cmd[0])) {
    const cmd = str((raw.parsed_cmd[0] as Obj).cmd);
    if (cmd) return cmd;
  }
  if (Array.isArray(raw.command)) {
    const last = raw.command.at(-1);
    if (typeof last === 'string') return last;
  }
  return title;
}
function describeCodexOutput(raw: unknown): string {
  if (!isObj(raw)) return '';
  return str(raw.formatted_output) ?? str(raw.aggregated_output) ?? '';
}
