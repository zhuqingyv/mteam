// T-7 单测：bus 侧 turn.* 事件类型契约冻结。
//
// 重点验证 4 件事：
//   1. BusEvent 联合 discriminated union 能按 'turn.*' 字面量收窄（on<T>() 会用到）
//   2. bus.emit + bus.on('turn.*') 路由正确，payload 透传不丢字段
//   3. makeBase 自动补 ts / source / eventId（A5 接线契约）
//   4. BusEventType 联合包含全部 4 条 turn.*（防白名单 / WS 广播漏事件）
//
// 不 mock bus：new EventBus() 隔离实例，和 event-bus.test.ts 同规范。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import type {
  BusEvent,
  BusEventType,
  TurnStartedEvent,
  TurnBlockUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
} from '../types.js';
import type { Turn, TurnBlock, UserInput } from '../../agent-driver/turn-types.js';

const SOURCE = 'test:turn-events';

function sampleUserInput(): UserInput {
  return { text: 'hi', ts: '2026-04-25T12:00:00.000Z' };
}

function sampleTextBlock(): TurnBlock {
  return {
    blockId: 'msg_1',
    type: 'text',
    scope: 'turn',
    status: 'streaming',
    seq: 0,
    startTs: '2026-04-25T12:00:00.100Z',
    updatedTs: '2026-04-25T12:00:00.500Z',
    messageId: 'msg_1',
    content: '你好',
  };
}

function sampleTurn(): Turn {
  return {
    turnId: 'turn_1',
    driverId: 'drv_A',
    status: 'done',
    userInput: sampleUserInput(),
    blocks: [sampleTextBlock()],
    stopReason: 'end_turn',
    startTs: '2026-04-25T12:00:00.100Z',
    endTs: '2026-04-25T12:00:05.000Z',
  };
}

describe('T-7 · bus turn.* 事件契约', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  // --- turn.started ---
  it('turn.started 字面量收窄后带 driverId / turnId / userInput', () => {
    const received: BusEvent[] = [];
    const sub = bus.on('turn.started').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('turn.started', SOURCE),
      driverId: 'drv_A',
      turnId: 'turn_1',
      userInput: sampleUserInput(),
    });

    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe('turn.started');
    if (received[0]!.type === 'turn.started') {
      const ev: TurnStartedEvent = received[0]!;
      expect(ev.driverId).toBe('drv_A');
      expect(ev.turnId).toBe('turn_1');
      expect(ev.userInput.text).toBe('hi');
      expect(typeof ev.eventId).toBe('string');
      expect(typeof ev.ts).toBe('string');
      expect(ev.source).toBe(SOURCE);
    }
    sub.unsubscribe();
  });

  // --- turn.block_updated ---
  it('turn.block_updated 外层 seq 与 block.seq 可独立设置（冗余外层用于路由过滤）', () => {
    const received: TurnBlockUpdatedEvent[] = [];
    const sub = bus.on('turn.block_updated').subscribe((e) => received.push(e));

    const block = sampleTextBlock();
    bus.emit({
      ...makeBase('turn.block_updated', SOURCE),
      driverId: 'drv_A',
      turnId: 'turn_1',
      seq: block.seq,
      block,
    });

    expect(received.length).toBe(1);
    const ev = received[0]!;
    expect(ev.driverId).toBe('drv_A');
    expect(ev.turnId).toBe('turn_1');
    expect(ev.seq).toBe(0);
    expect(ev.block.blockId).toBe('msg_1');
    expect(ev.block.type).toBe('text');
    expect(ev.block.scope).toBe('turn');
    sub.unsubscribe();
  });

  // --- turn.completed ---
  it('turn.completed 带完整 Turn，前端归档到本地 history', () => {
    const received: TurnCompletedEvent[] = [];
    const sub = bus.on('turn.completed').subscribe((e) => received.push(e));

    const turn = sampleTurn();
    bus.emit({
      ...makeBase('turn.completed', SOURCE),
      driverId: turn.driverId,
      turnId: turn.turnId,
      turn,
    });

    expect(received.length).toBe(1);
    const ev = received[0]!;
    expect(ev.turn.turnId).toBe('turn_1');
    expect(ev.turn.status).toBe('done');
    expect(ev.turn.stopReason).toBe('end_turn');
    expect(ev.turn.blocks.length).toBe(1);
    sub.unsubscribe();
  });

  // --- turn.error ---
  it('turn.error 带 message，与 turn.completed 可同时发', () => {
    const done: TurnCompletedEvent[] = [];
    const err: TurnErrorEvent[] = [];
    const s1 = bus.on('turn.completed').subscribe((e) => done.push(e));
    const s2 = bus.on('turn.error').subscribe((e) => err.push(e));

    const turn: Turn = { ...sampleTurn(), status: 'error', stopReason: 'crashed' };
    bus.emit({
      ...makeBase('turn.completed', SOURCE),
      driverId: turn.driverId,
      turnId: turn.turnId,
      turn,
    });
    bus.emit({
      ...makeBase('turn.error', SOURCE),
      driverId: turn.driverId,
      turnId: turn.turnId,
      message: 'adapter crashed',
    });

    expect(done.length).toBe(1);
    expect(err.length).toBe(1);
    expect(err[0]!.message).toBe('adapter crashed');
    s1.unsubscribe();
    s2.unsubscribe();
  });

  // --- BusEventType 联合完整性 ---
  it('BusEventType 包含全部 4 条 turn.*', () => {
    // 编译期：以下赋值若联合漏成员 tsc 会失败；运行期字符串对比兜底。
    const expected: BusEventType[] = [
      'turn.started',
      'turn.block_updated',
      'turn.completed',
      'turn.error',
    ];
    for (const t of expected) {
      expect(typeof t).toBe('string');
    }
  });

  // --- prefix 订阅能收全 turn.* 四条 ---
  it('onPrefix("turn.") 能收到全部 4 条 turn.*', () => {
    const types: string[] = [];
    const sub = bus.onPrefix('turn.').subscribe((e) => types.push(e.type));

    // 注意：makeBase 的字面量类型参数 T 必须在每次调用点独立传，用泛型 helper 会把
    // T 推断成 union 导致 BusEvent discriminant 收窄失败。
    bus.emit({
      ...makeBase('turn.started', SOURCE),
      driverId: 'd',
      turnId: 't',
      userInput: sampleUserInput(),
    });
    bus.emit({
      ...makeBase('turn.block_updated', SOURCE),
      driverId: 'd',
      turnId: 't',
      seq: 0,
      block: sampleTextBlock(),
    });
    bus.emit({
      ...makeBase('turn.completed', SOURCE),
      driverId: 'd',
      turnId: 't',
      turn: sampleTurn(),
    });
    bus.emit({
      ...makeBase('turn.error', SOURCE),
      driverId: 'd',
      turnId: 't',
      message: 'x',
    });

    expect(types).toEqual([
      'turn.started',
      'turn.block_updated',
      'turn.completed',
      'turn.error',
    ]);
    sub.unsubscribe();
  });
});

describe('T-7 · makeBase helpers', () => {
  it('makeBase 自动填 eventId / ts / source', () => {
    const base = makeBase('turn.started', SOURCE);
    expect(base.type).toBe('turn.started');
    expect(typeof base.eventId).toBe('string');
    expect(base.eventId.length).toBeGreaterThan(10);
    expect(typeof base.ts).toBe('string');
    // ISO 8601 形状
    expect(base.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(base.source).toBe(SOURCE);
    expect(base.correlationId).toBeUndefined();
  });

  it('makeBase 传 correlationId 会透传', () => {
    const base = makeBase('turn.block_updated', SOURCE, 'corr-123');
    expect(base.correlationId).toBe('corr-123');
  });

  it('两次 makeBase 的 eventId 不同（随机 UUID）', () => {
    const a = makeBase('turn.started', SOURCE);
    const b = makeBase('turn.started', SOURCE);
    expect(a.eventId).not.toBe(b.eventId);
  });
});
