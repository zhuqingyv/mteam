// W1-8 · WS 白名单独立测试。
// 守两件事：
//   1) WS_EVENT_TYPES 真源在 ws/event-types.ts（不是旧 ws.subscriber.ts）。
//   2) 旧 ws.subscriber.ts 的 re-export 与真源是同一份 Set 引用，保证 W2-H
//      守门测试不因两个 Set 副本漂移而误判。
import { describe, it, expect } from 'bun:test';
import { WS_EVENT_TYPES } from './event-types.js';
import { WS_EVENT_TYPES as REEXPORT } from '../bus/subscribers/ws.subscriber.js';
import type { BusEventType } from '../bus/types.js';

describe('W1-8 · WS_EVENT_TYPES 迁移', () => {
  it('真源在 ws/event-types.ts：集合尺寸 = 40（Phase 4 新增 5 条 action_item.*）', () => {
    expect(WS_EVENT_TYPES.size).toBe(40);
  });

  it('旧 ws.subscriber.ts 的 re-export 指向同一份 Set（同引用）', () => {
    // 同引用 = 不存在两个副本，任何未来改白名单的 PR 只会动一处。
    expect(REEXPORT).toBe(WS_EVENT_TYPES);
  });

  it('W1-7 新增 reliability 域 3 条默认不暴露给前端', () => {
    expect(WS_EVENT_TYPES.has('runtime.fatal' as BusEventType)).toBe(false);
    expect(WS_EVENT_TYPES.has('memory.warn' as BusEventType)).toBe(false);
    expect(WS_EVENT_TYPES.has('process.reaped' as BusEventType)).toBe(false);
  });

  it('保留关键成员：comm / driver 生命周期 / turn.*', () => {
    expect(WS_EVENT_TYPES.has('comm.message_sent')).toBe(true);
    expect(WS_EVENT_TYPES.has('comm.message_received')).toBe(true);
    expect(WS_EVENT_TYPES.has('driver.started')).toBe(true);
    expect(WS_EVENT_TYPES.has('driver.stopped')).toBe(true);
    expect(WS_EVENT_TYPES.has('driver.error')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.started')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.block_updated')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.completed')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.error')).toBe(true);
  });
});
