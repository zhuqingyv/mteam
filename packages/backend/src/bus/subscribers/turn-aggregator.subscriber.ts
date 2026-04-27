// Turn 聚合器 —— 订阅 driver.* bus 事件，调用 turn-store 更新 in-memory Turn，
// 产出 turn.started / turn.block_updated / turn.completed / turn.error。
//
// 权威设计：docs/phase-ws/turn-aggregator-design.md §4
// 时序/竞态/错误传播：TURN-AGGREGATOR-README.md
// 存储层在 turn-store.ts；本文件只做事件翻译 + Turn 边界编排。
//
// 核心不变量：
//   1. block.seq 每 turn 从 0 起（store 负责）
//   2. Turn.userInput 必由 driver.turn_start 提供，缺失不新建 Turn
//   3. Turn 边界双保险：turn_start 开；turn_done/error/stopped 关（reviewer A）
//   4. history 环形 cap 条，Hub 重启即丢失（§4.6 已定边界）
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { createTurnStore } from './turn-store.js';
import type {
  AcpContent, CommandDescriptor, ConfigOption, Location, PlanEntry,
  StopReason, ThinkingBlock, TextBlock, ToolCallBlock, ToolKind, ToolStatus,
  Turn, TurnBlock, UserInput, VendorOutput, VendorPayload,
} from '../../agent-driver/turn-types.js';
import type {
  DriverCommandsEvent, DriverConfigEvent, DriverErrorEvent, DriverModeEvent,
  DriverPlanEvent, DriverSessionInfoEvent, DriverStoppedEvent, DriverTextEvent,
  DriverThinkingEvent, DriverToolCallEvent, DriverToolUpdateEvent,
  DriverTurnDoneEvent, DriverTurnStartEvent, DriverUsageEvent,
} from '../driver-events.js';

const DEFAULT_HISTORY_PER_DRIVER = 50;
const SOURCE = 'bus/turn-aggregator';

export interface TurnAggregator {
  getActive(driverId: string): Turn | null;
  getRecent(driverId: string, limit: number): Turn[];
}

export function subscribeTurnAggregator(
  eventBus: EventBus = defaultBus,
  opts?: { historyPerDriver?: number },
): { aggregator: TurnAggregator; subscription: Subscription } {
  const store = createTurnStore(Math.max(1, opts?.historyPerDriver ?? DEFAULT_HISTORY_PER_DRIVER));
  const sub = new Subscription();
  const on = <T extends Parameters<EventBus['on']>[0]>(t: T, fn: (e: Extract<Parameters<EventBus['emit']>[0], { type: T }>) => void): void => {
    sub.add(eventBus.on(t).subscribe((e) => wrap(e, () => fn(e as never))));
  };

  // ---------- Turn 边界 ----------
  on('driver.turn_start', onTurnStart);
  on('driver.turn_done', onTurnDone);
  on('driver.error', (e: DriverErrorEvent) => abortActive(e.driverId, e.correlationId, e.message));
  on('driver.stopped', (e: DriverStoppedEvent) => abortActive(e.driverId, e.correlationId, 'driver stopped'));

  // ---------- Block handlers ----------
  on('driver.thinking', (e: DriverThinkingEvent) => onTextLike(e, 'thinking'));
  on('driver.text', (e: DriverTextEvent) => onTextLike(e, 'text'));
  on('driver.tool_call', onToolCall);
  on('driver.tool_update', onToolUpdate);
  on('driver.plan', (e: DriverPlanEvent) => upsertTurnScoped(e, `plan-${activeTurnId(e.driverId)}`, 'plan', 'streaming', { entries: e.entries as PlanEntry[] }));
  on('driver.usage', (e: DriverUsageEvent) => upsertTurnScoped(e, `usage-${activeTurnId(e.driverId)}`, 'usage', 'done', { used: e.used, size: e.size, ...(e.cost ? { cost: e.cost } : {}) }));
  on('driver.commands', (e: DriverCommandsEvent) => upsertSessionScoped(e, 'commands', { commands: e.commands as CommandDescriptor[] }));
  on('driver.mode', (e: DriverModeEvent) => upsertSessionScoped(e, 'mode', { currentModeId: e.currentModeId }));
  on('driver.config', (e: DriverConfigEvent) => upsertSessionScoped(e, 'config', { options: e.options as ConfigOption[] }));
  on('driver.session_info', (e: DriverSessionInfoEvent) => upsertSessionScoped(e, 'session_info', {
    ...(e.title !== undefined ? { title: e.title } : {}),
    ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}),
  }));

  return { aggregator: store, subscription: sub };

  // ---------- Turn 生命周期 ----------

  function onTurnStart(e: DriverTurnStartEvent): void {
    if (store.peekActive(e.driverId)) {
      // 上一轮 active 没收到 turn_done → 兜底强制结算，避免悬挂泄漏。
      store.closeActiveAsCrashed(e.driverId, 'crashed');
      finish(e.driverId, 'error', e.correlationId, 'replaced by new turn_start');
    }
    const userInput: UserInput = {
      text: e.userInput.text, ts: e.userInput.ts,
      ...(e.userInput.attachments ? { attachments: e.userInput.attachments as AcpContent[] } : {}),
    };
    store.openTurn({
      turnId: e.turnId, driverId: e.driverId, status: 'active',
      userInput, blocks: [], startTs: e.ts,
    });
    eventBus.emit({ ...makeBase('turn.started', SOURCE, e.correlationId), driverId: e.driverId, turnId: e.turnId, userInput });
  }

  function onTurnDone(e: DriverTurnDoneEvent): void {
    const st = store.peekActive(e.driverId);
    if (!st) return;
    if (e.turnId && e.turnId !== st.turn.turnId) return; // 老事件 / turnId 漂移
    st.turn.stopReason = (e.stopReason as StopReason | undefined) ?? 'end_turn';
    if (e.usage) st.turn.usage = e.usage;
    finish(e.driverId, 'done', e.correlationId);
  }

  function abortActive(driverId: string, correlationId?: string, reason?: string): void {
    if (!store.peekActive(driverId)) return;
    store.closeActiveAsCrashed(driverId, 'crashed');
    finish(driverId, 'error', correlationId, reason);
  }

  // ---------- Block handlers ----------

  function onTextLike(e: DriverThinkingEvent | DriverTextEvent, type: 'thinking' | 'text'): void {
    const turnId = activeTurnId(e.driverId);
    if (!turnId) return;
    const blockId = e.messageId ?? `${type}-${turnId}`;
    upsertEmit(e.driverId, e.correlationId, blockId, (seq, prev) => {
      const base = { blockId, type, scope: 'turn' as const, status: 'streaming' as const, seq,
        startTs: prev?.startTs ?? e.ts, updatedTs: e.ts, content: e.content };
      return (e.messageId ? { ...base, messageId: e.messageId } : base) as ThinkingBlock | TextBlock;
    });
  }

  function onToolCall(e: DriverToolCallEvent): void {
    const blockId = e.toolCallId ?? e.name;
    upsertEmit(e.driverId, e.correlationId, blockId, (seq, prev) => {
      const p = prev?.type === 'tool_call' ? (prev as ToolCallBlock) : undefined;
      return {
        blockId, type: 'tool_call', scope: 'turn', status: 'streaming', seq,
        startTs: prev?.startTs ?? e.ts, updatedTs: e.ts,
        toolCallId: blockId, title: e.title ?? e.name,
        toolStatus: (e.status as ToolStatus | undefined) ?? p?.toolStatus ?? 'pending',
        input: toVendorPayload(e.input, 'claude'),
        ...pickOpt('kind', e.kind as ToolKind | undefined, p?.kind),
        ...pickOpt('locations', e.locations as Location[] | undefined, p?.locations),
        ...pickOpt('content', e.content as AcpContent[] | undefined, p?.content),
        ...(p?.output ? { output: p.output } : {}),
      } satisfies ToolCallBlock;
    });
  }

  function onToolUpdate(e: DriverToolUpdateEvent): void {
    upsertEmit(e.driverId, e.correlationId, e.toolCallId, (seq, prev) => {
      const p = prev?.type === 'tool_call' ? (prev as ToolCallBlock) : undefined;
      const toolStatus = (e.status as ToolStatus | undefined) ?? p?.toolStatus ?? 'in_progress';
      return {
        blockId: e.toolCallId, type: 'tool_call', scope: 'turn',
        status: toolStatus === 'completed' || toolStatus === 'failed' ? 'done' : 'streaming', seq,
        startTs: prev?.startTs ?? e.ts, updatedTs: e.ts,
        toolCallId: e.toolCallId, title: e.title ?? p?.title ?? e.toolCallId,
        toolStatus,
        input: p?.input ?? { vendor: 'claude', display: '', data: undefined },
        ...pickOpt('kind', e.kind as ToolKind | undefined, p?.kind),
        ...pickOpt('locations', e.locations as Location[] | undefined, p?.locations),
        ...(e.output ? { output: toVendorOutput(e.output) } : p?.output ? { output: p.output } : {}),
        ...pickOpt('content', e.content as AcpContent[] | undefined, p?.content),
      } satisfies ToolCallBlock;
    });
  }

  // turn-scoped（plan/usage）：blockId 带 turnId 前缀，status 由调用方决定
  function upsertTurnScoped(
    e: { driverId: string; ts: string; correlationId?: string },
    blockId: string | null,
    type: 'plan' | 'usage',
    status: 'streaming' | 'done',
    extra: Record<string, unknown>,
  ): void {
    if (!blockId || blockId.endsWith('-null')) return; // 无 active turn
    upsertEmit(e.driverId, e.correlationId, blockId, (seq, prev) => ({
      blockId, type, scope: 'turn', status, seq,
      startTs: prev?.startTs ?? e.ts, updatedTs: e.ts, ...extra,
    } as TurnBlock));
  }

  // session-scoped（commands/mode/config/session_info）：blockId 为固定字面量，status 恒 done
  function upsertSessionScoped(
    e: { driverId: string; ts: string; correlationId?: string },
    blockId: 'commands' | 'mode' | 'config' | 'session_info',
    extra: Record<string, unknown>,
  ): void {
    upsertEmit(e.driverId, e.correlationId, blockId, (seq, prev) => ({
      blockId, type: blockId, scope: 'session', status: 'done', seq,
      startTs: prev?.startTs ?? e.ts, updatedTs: e.ts, ...extra,
    } as TurnBlock));
  }

  // ---------- internals ----------

  function activeTurnId(driverId: string): string | null {
    return store.peekActive(driverId)?.turn.turnId ?? null;
  }

  function upsertEmit(
    driverId: string, correlationId: string | undefined,
    blockId: string, build: (seq: number, prev: TurnBlock | undefined) => TurnBlock,
  ): void {
    const res = store.upsert(driverId, blockId, build);
    if (!res) return; // 无 active Turn：丢弃（设计 §4.5）
    eventBus.emit({
      ...makeBase('turn.block_updated', SOURCE, correlationId),
      driverId, turnId: res.state.turn.turnId, seq: res.block.seq, block: res.block,
    });
  }

  function finish(
    driverId: string, outcome: 'done' | 'error',
    correlationId?: string, errMessage?: string,
  ): void {
    const st = store.finish(driverId, outcome);
    if (!st) return;
    eventBus.emit({
      ...makeBase('turn.completed', SOURCE, correlationId),
      driverId, turnId: st.turn.turnId, turn: st.turn,
    });
    if (outcome === 'error') {
      eventBus.emit({
        ...makeBase('turn.error', SOURCE, correlationId),
        driverId, turnId: st.turn.turnId, message: errMessage ?? 'turn aborted',
      });
    }
  }
}

function wrap<T extends { type: string; driverId?: string }>(e: T, fn: () => void): void {
  try { fn(); }
  catch (err) {
    process.stderr.write(
      `[bus/turn-aggregator] handler failed for ${e.type} driverId=${e.driverId ?? '?'}: ${(err as Error).message}\n`,
    );
  }
}

// ---------- vendor 归一化：bus 上 input/output 形状宽松（过渡期），收敛到 VendorPayload ----------

function toVendorPayload(raw: unknown, fallbackVendor: 'claude' | 'codex'): VendorPayload {
  if (raw && typeof raw === 'object' && 'vendor' in raw && 'display' in raw && 'data' in raw) {
    const r = raw as VendorPayload;
    return { vendor: r.vendor, display: r.display, data: r.data };
  }
  return { vendor: fallbackVendor, display: '', data: raw };
}

function toVendorOutput(raw: { vendor: string; display: string; data: unknown; exitCode?: number }): VendorOutput {
  return {
    vendor: raw.vendor as 'claude' | 'codex',
    display: raw.display, data: raw.data,
    ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
  };
}

function pickOpt<K extends string, V>(
  key: K, next: V | undefined, prev: V | undefined,
): Partial<Record<K, V>> {
  if (next !== undefined) return { [key]: next } as Partial<Record<K, V>>;
  if (prev !== undefined) return { [key]: prev } as Partial<Record<K, V>>;
  return {};
}
