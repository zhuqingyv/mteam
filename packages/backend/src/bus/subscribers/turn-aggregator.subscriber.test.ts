// turn-aggregator.subscriber 单测 —— 真 EventBus，不 mock bus/db。
// 场景覆盖：turn_start 建 Turn + 发 turn.started；thinking/text 按 messageId 合并；
// tool_call + tool_update 合并；seq 每 turn 从 0 起且首次分配后不变；
// plan/usage/session-scoped block；turn_done 正常结束；driver.error 强制关闭；
// driver.stopped 强制关闭；history 环形容量；getActive / getRecent；无 active 时 block 事件被丢弃。
import { describe, it, expect } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { subscribeTurnAggregator } from './turn-aggregator.subscriber.js';
import type { BusEvent, TurnBlockUpdatedEvent, TurnCompletedEvent, TurnErrorEvent, TurnStartedEvent } from '../events.js';
import type { ToolCallBlock, TextBlock, ThinkingBlock, PlanBlock } from '../../agent-driver/turn-types.js';

interface Ctx {
  bus: EventBus;
  aggregator: ReturnType<typeof subscribeTurnAggregator>['aggregator'];
  all: BusEvent[];
  started: TurnStartedEvent[];
  updated: TurnBlockUpdatedEvent[];
  completed: TurnCompletedEvent[];
  errored: TurnErrorEvent[];
}

function setup(historyPerDriver = 50): Ctx {
  const bus = new EventBus();
  const { aggregator } = subscribeTurnAggregator(bus, { historyPerDriver });
  const ctx: Ctx = { bus, aggregator, all: [], started: [], updated: [], completed: [], errored: [] };
  bus.events$.subscribe((e) => {
    ctx.all.push(e);
    if (e.type === 'turn.started') ctx.started.push(e);
    else if (e.type === 'turn.block_updated') ctx.updated.push(e);
    else if (e.type === 'turn.completed') ctx.completed.push(e);
    else if (e.type === 'turn.error') ctx.errored.push(e);
  });
  return ctx;
}

function emitTurnStart(bus: EventBus, driverId: string, turnId: string, text = 'hi'): void {
  bus.emit({
    ...makeBase('driver.turn_start', 'test'),
    driverId, turnId,
    userInput: { text, ts: '2026-04-25T00:00:00.000Z' },
  });
}

describe('turn-aggregator · Turn 边界', () => {
  it('driver.turn_start → 新建 active Turn + emit turn.started（带 userInput）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1', 'analyze log');
    expect(ctx.started).toHaveLength(1);
    expect(ctx.started[0].turnId).toBe('t1');
    expect(ctx.started[0].userInput.text).toBe('analyze log');
    const active = ctx.aggregator.getActive('d1');
    expect(active).not.toBeNull();
    expect(active?.status).toBe('active');
    expect(active?.blocks).toHaveLength(0);
  });

  it('driver.turn_done → 关闭 active，移入 history，emit turn.completed', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.turn_done', 'test'), driverId: 'd1', turnId: 't1', stopReason: 'end_turn' });
    expect(ctx.aggregator.getActive('d1')).toBeNull();
    expect(ctx.completed).toHaveLength(1);
    expect(ctx.completed[0].turn.status).toBe('done');
    expect(ctx.completed[0].turn.stopReason).toBe('end_turn');
    expect(ctx.errored).toHaveLength(0);
    const recent = ctx.aggregator.getRecent('d1', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].turnId).toBe('t1');
  });

  it('driver.error 有 active → 强制关闭 + emit turn.completed(error) + turn.error', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.error', 'test'), driverId: 'd1', message: 'boom' });
    expect(ctx.aggregator.getActive('d1')).toBeNull();
    expect(ctx.completed).toHaveLength(1);
    expect(ctx.completed[0].turn.status).toBe('error');
    expect(ctx.completed[0].turn.stopReason).toBe('crashed');
    expect(ctx.errored).toHaveLength(1);
    expect(ctx.errored[0].message).toBe('boom');
  });

  it('driver.stopped 有 active → 强制关闭（视为 error，避免悬挂）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.stopped', 'test'), driverId: 'd1' });
    expect(ctx.aggregator.getActive('d1')).toBeNull();
    expect(ctx.completed).toHaveLength(1);
    expect(ctx.completed[0].turn.status).toBe('error');
    expect(ctx.errored).toHaveLength(1);
  });

  it('driver.error 无 active → 静默，不 emit turn.*', () => {
    const ctx = setup();
    ctx.bus.emit({ ...makeBase('driver.error', 'test'), driverId: 'd1', message: 'oops' });
    expect(ctx.completed).toHaveLength(0);
    expect(ctx.errored).toHaveLength(0);
  });

  it('driver.turn_done turnId 不匹配 → 忽略（老事件漂移）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't-current');
    ctx.bus.emit({ ...makeBase('driver.turn_done', 'test'), driverId: 'd1', turnId: 't-old', stopReason: 'end_turn' });
    expect(ctx.aggregator.getActive('d1')?.turnId).toBe('t-current');
    expect(ctx.completed).toHaveLength(0);
  });

  it('新 turn_start 碰上未关的 active → 先强制结算旧 Turn 再开新 Turn', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    emitTurnStart(ctx.bus, 'd1', 't2');
    expect(ctx.aggregator.getActive('d1')?.turnId).toBe('t2');
    expect(ctx.completed).toHaveLength(1);
    expect(ctx.completed[0].turnId).toBe('t1');
    expect(ctx.completed[0].turn.status).toBe('error');
    expect(ctx.errored).toHaveLength(1);
  });
});

describe('turn-aggregator · Block 聚合', () => {
  it('driver.text 有 messageId → 同一 messageId 合并为一个 block（content 全量累加）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm1', content: '1 2 3 4' });
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm1', content: ' 5' });
    const blocks = ctx.aggregator.getActive('d1')!.blocks as TextBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('1 2 3 4 5');
    expect(blocks[0].seq).toBe(0);
    // turn.block_updated 携带累加全文，前端可直接覆盖渲染
    expect(ctx.updated).toHaveLength(2);
    expect((ctx.updated[0].block as TextBlock).content).toBe('1 2 3 4');
    expect((ctx.updated[1].block as TextBlock).content).toBe('1 2 3 4 5');
    // seq 首次分配后不变
    expect(ctx.updated[0].seq).toBe(0);
    expect(ctx.updated[1].seq).toBe(0);
  });

  it('driver.text 无 messageId → 按 text-{turnId} 合并（累加）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', content: 'a' });
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', content: 'b' });
    const blocks = ctx.aggregator.getActive('d1')!.blocks as TextBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe('text-t1');
    expect(blocks[0].content).toBe('ab');
  });

  it('driver.thinking 连续 chunk → content 全量累加', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.thinking', 'test'), driverId: 'd1', messageId: 'th1', content: 'let me think' });
    ctx.bus.emit({ ...makeBase('driver.thinking', 'test'), driverId: 'd1', messageId: 'th1', content: ' harder' });
    const blocks = ctx.aggregator.getActive('d1')!.blocks as ThinkingBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('let me think harder');
  });

  it('driver.thinking 与 driver.text 各自独立 block（type 不同）', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.thinking', 'test'), driverId: 'd1', content: 'hmm' });
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', content: 'ok' });
    const blocks = ctx.aggregator.getActive('d1')!.blocks;
    expect(blocks).toHaveLength(2);
    const thinking = blocks.find((b) => b.type === 'thinking') as ThinkingBlock;
    const text = blocks.find((b) => b.type === 'text') as TextBlock;
    expect(thinking.content).toBe('hmm');
    expect(text.content).toBe('ok');
    expect(thinking.seq).toBe(0);
    expect(text.seq).toBe(1);
  });

  it('seq 每 turn 从 0 重开', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm1', content: 'a' });
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm2', content: 'b' });
    ctx.bus.emit({ ...makeBase('driver.turn_done', 'test'), driverId: 'd1', turnId: 't1', stopReason: 'end_turn' });
    emitTurnStart(ctx.bus, 'd1', 't2');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm3', content: 'c' });
    const active = ctx.aggregator.getActive('d1')!;
    expect(active.blocks[0].seq).toBe(0);
  });

  it('tool_call + tool_update 合并到同一 block；toolStatus=completed → status=done', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({
      ...makeBase('driver.tool_call', 'test'), driverId: 'd1',
      name: 'Bash', toolCallId: 'c1',
      input: { vendor: 'codex', display: 'ls', data: { command: ['ls'] } },
    });
    ctx.bus.emit({
      ...makeBase('driver.tool_update', 'test'), driverId: 'd1',
      toolCallId: 'c1', status: 'completed',
      output: { vendor: 'codex', display: 'ok', data: { stdout: 'ok' }, exitCode: 0 },
    });
    const blocks = ctx.aggregator.getActive('d1')!.blocks as ToolCallBlock[];
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.toolCallId).toBe('c1');
    expect(b.toolStatus).toBe('completed');
    expect(b.status).toBe('done');
    expect(b.input.display).toBe('ls');
    expect(b.output?.display).toBe('ok');
    expect(b.output?.exitCode).toBe(0);
  });

  it('tool_call 不带 VendorPayload → 回落到 fallback vendor + data 透传', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({
      ...makeBase('driver.tool_call', 'test'), driverId: 'd1',
      name: 'Read', toolCallId: 'c1',
      input: { file_path: '/tmp/x' },   // 老形状：裸字典
    });
    const b = ctx.aggregator.getActive('d1')!.blocks[0] as ToolCallBlock;
    expect(b.input.vendor).toBe('claude');
    expect(b.input.display).toBe('');
    expect(b.input.data).toEqual({ file_path: '/tmp/x' });
  });

  it('driver.plan → block 固定 id plan-{turnId}，全量替换 entries', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({
      ...makeBase('driver.plan', 'test'), driverId: 'd1',
      entries: [{ content: 'a', priority: 'high', status: 'pending' }],
    });
    ctx.bus.emit({
      ...makeBase('driver.plan', 'test'), driverId: 'd1',
      entries: [
        { content: 'a', priority: 'high', status: 'completed' },
        { content: 'b', priority: 'medium', status: 'in_progress' },
      ],
    });
    const blocks = ctx.aggregator.getActive('d1')!.blocks as PlanBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe('plan-t1');
    expect(blocks[0].entries).toHaveLength(2);
    expect(blocks[0].entries[0].status).toBe('completed');
  });

  it('driver.mode (session scope) → blockId="mode"', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.mode', 'test'), driverId: 'd1', currentModeId: 'plan' });
    const blocks = ctx.aggregator.getActive('d1')!.blocks;
    expect(blocks[0].blockId).toBe('mode');
    expect(blocks[0].scope).toBe('session');
    expect(blocks[0].type).toBe('mode');
  });

  it('无 active Turn 时 driver.text → 丢弃，无 turn.block_updated', () => {
    const ctx = setup();
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', content: 'orphan' });
    expect(ctx.updated).toHaveLength(0);
    expect(ctx.aggregator.getActive('d1')).toBeNull();
  });

  it('turn 完成时流式 block 被封口为 done', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'd1', 't1');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'd1', messageId: 'm1', content: 'hi' });
    ctx.bus.emit({ ...makeBase('driver.turn_done', 'test'), driverId: 'd1', turnId: 't1', stopReason: 'end_turn' });
    const turn = ctx.completed[0].turn;
    expect(turn.blocks[0].status).toBe('done');
  });
});

describe('turn-aggregator · 历史 + API', () => {
  it('history 最新优先；getRecent(N) 截断', () => {
    const ctx = setup(3);
    for (let i = 0; i < 5; i++) {
      emitTurnStart(ctx.bus, 'd1', `t${i}`);
      ctx.bus.emit({ ...makeBase('driver.turn_done', 'test'), driverId: 'd1', turnId: `t${i}`, stopReason: 'end_turn' });
    }
    const recent = ctx.aggregator.getRecent('d1', 10);
    expect(recent.map((t) => t.turnId)).toEqual(['t4', 't3', 't2']); // 环形 cap=3
    expect(ctx.aggregator.getRecent('d1', 2).map((t) => t.turnId)).toEqual(['t4', 't3']);
  });

  it('driver 从未出现 → getRecent / getActive 返回空（不抛）', () => {
    const ctx = setup();
    expect(ctx.aggregator.getActive('nobody')).toBeNull();
    expect(ctx.aggregator.getRecent('nobody', 5)).toEqual([]);
  });

  it('跨 driverId 不互相污染', () => {
    const ctx = setup();
    emitTurnStart(ctx.bus, 'dA', 'tA');
    emitTurnStart(ctx.bus, 'dB', 'tB');
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'dA', messageId: 'mA', content: 'A' });
    ctx.bus.emit({ ...makeBase('driver.text', 'test'), driverId: 'dB', messageId: 'mB', content: 'B' });
    expect((ctx.aggregator.getActive('dA')!.blocks[0] as TextBlock).content).toBe('A');
    expect((ctx.aggregator.getActive('dB')!.blocks[0] as TextBlock).content).toBe('B');
  });
});

describe('turn-aggregator · correlationId 透传', () => {
  it('driver.turn_start.correlationId → turn.started.correlationId', () => {
    const ctx = setup();
    ctx.bus.emit({
      ...makeBase('driver.turn_start', 'test', 'corr-1'),
      driverId: 'd1', turnId: 't1',
      userInput: { text: 'x', ts: '2026-04-25T00:00:00.000Z' },
    });
    expect(ctx.started[0].correlationId).toBe('corr-1');
  });
});
