// useInstanceSubscriptions 核心逻辑单测。
//
// hook 本体是 React useEffect 薄绑定，核心 diff/debounce/teardown 逻辑在
// SubscriptionTracker 里，测试直接驱动它，不依赖 React runtime。

import { describe, test, expect } from 'bun:test';
import { diffSubscriptions, SubscriptionTracker } from '../useInstanceSubscriptions';
import type { WsClient } from '../../api/ws-protocol';

type Call = { op: 'subscribe' | 'unsubscribe'; scope: string; id?: string };

function makeFakeClient(): { client: WsClient; calls: Call[] } {
  const calls: Call[] = [];
  const noop = () => {};
  const client: WsClient = {
    send: noop,
    subscribe: (scope, id) => { calls.push({ op: 'subscribe', scope, id }); },
    unsubscribe: (scope, id) => { calls.push({ op: 'unsubscribe', scope, id }); },
    prompt: noop,
    cancelTurn: noop,
    configurePrimaryAgent: noop,
    getTurns: noop,
    getTurnHistory: noop,
    getWorkers: noop,
    ping: noop,
    close: noop,
    onEvent: noop,
    onAck: noop,
    onError: noop,
    onSnapshot: noop,
    onTurnsResponse: noop,
    onTurnHistoryResponse: noop,
    onWorkersResponse: noop,
    onReconnect: noop,
    readyState: () => 1,
  };
  return { client, calls };
}

// fake scheduler：不真等 ms，手动 tick。
function makeFakeClock() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const schedule = ((cb: () => void): number => {
    const id = ++seq;
    pending.set(id, cb);
    return id;
  }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  const cancel = ((id: number) => {
    pending.delete(id);
  }) as unknown as (id: ReturnType<typeof setTimeout>) => void;
  const tickAll = () => {
    const tasks = Array.from(pending.values());
    pending.clear();
    for (const cb of tasks) cb();
  };
  return { schedule, cancel, tickAll, pendingCount: () => pending.size };
}

describe('diffSubscriptions', () => {
  test('纯新增 / 纯删除 / 混合', () => {
    const r1 = diffSubscriptions(new Set(), ['a', 'b']);
    expect(r1.toAdd.sort()).toEqual(['a', 'b']);
    expect(r1.toRemove).toEqual([]);

    const r2 = diffSubscriptions(new Set(['a', 'b']), []);
    expect(r2.toAdd).toEqual([]);
    expect(r2.toRemove.sort()).toEqual(['a', 'b']);

    const r3 = diffSubscriptions(new Set(['a', 'b']), ['b', 'c']);
    expect(r3.toAdd).toEqual(['c']);
    expect(r3.toRemove).toEqual(['a']);
    expect(r3.nextSet.size).toBe(2);
  });

  test('重复 id 归一：同一 id 只计一次', () => {
    const r = diffSubscriptions(new Set(), ['a', 'a', 'b', 'a']);
    expect(r.toAdd.sort()).toEqual(['a', 'b']);
    expect(r.nextSet.size).toBe(2);
  });

  test('空字符串被过滤，不生成订阅', () => {
    const r = diffSubscriptions(new Set(), ['', 'a', '']);
    expect(r.toAdd).toEqual(['a']);
    expect(r.nextSet.has('')).toBe(false);
  });
});

describe('SubscriptionTracker', () => {
  test('client=null 时 update/flush 都 no-op，不抛错', () => {
    const tracker = new SubscriptionTracker(null);
    tracker.update(['a', 'b']);
    tracker.flush();
    tracker.dispose();
    expect(tracker._currentForTest().size).toBe(0);
  });

  test('基本新增：update → debounce → flush 发 subscribe', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'b']);
    // debounce 未到：不应有任何 WS 调用
    expect(calls.length).toBe(0);

    clock.tickAll();
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.op === 'subscribe' && c.scope === 'instance')).toBe(true);
    expect(calls.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  test('快速连续 update 合并：只走一次 diff', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a']);
    tracker.update(['a', 'b']);
    tracker.update(['b', 'c']);
    expect(clock.pendingCount()).toBe(1); // 每次重置 timer，只留最后一个
    expect(calls.length).toBe(0);

    clock.tickAll();
    // 最终状态 {b, c}：subscribe b, subscribe c，没有 a 的中间态订/退
    const ops = calls.map((c) => `${c.op}:${c.id}`).sort();
    expect(ops).toEqual(['subscribe:b', 'subscribe:c']);
  });

  test('重复 id 只订一次', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'a', 'a']);
    clock.tickAll();
    expect(calls.filter((c) => c.op === 'subscribe' && c.id === 'a').length).toBe(1);
  });

  test('后续 update 计算增量：A→A,B 只补 subscribe B', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a']);
    clock.tickAll();
    expect(calls.length).toBe(1);

    calls.length = 0;
    tracker.update(['a', 'b']);
    clock.tickAll();
    expect(calls).toEqual([{ op: 'subscribe', scope: 'instance', id: 'b' }]);
  });

  test('后续 update 计算增量：A,B→B 只 unsubscribe A', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'b']);
    clock.tickAll();
    calls.length = 0;

    tracker.update(['b']);
    clock.tickAll();
    expect(calls).toEqual([{ op: 'unsubscribe', scope: 'instance', id: 'a' }]);
  });

  test('相同内容的新数组（引用变化）不发 WS 命令', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'b']);
    clock.tickAll();
    calls.length = 0;

    tracker.update(['a', 'b']);
    clock.tickAll();
    expect(calls.length).toBe(0);
  });

  test('dispose 清 pending timer 并 unsubscribe 所有已生效 id', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'b']);
    clock.tickAll();
    calls.length = 0;

    // 再发一个变更但不 tick：pending 在 timer 里
    tracker.update(['a', 'b', 'c']);
    expect(tracker._hasPendingTimer()).toBe(true);

    tracker.dispose();
    // pending timer 被取消，c 没订进去，不应该 unsubscribe c
    expect(tracker._hasPendingTimer()).toBe(false);
    const unsubIds = calls.filter((c) => c.op === 'unsubscribe').map((c) => c.id).sort();
    expect(unsubIds).toEqual(['a', 'b']);
    expect(calls.some((c) => c.op === 'unsubscribe' && c.id === 'c')).toBe(false);
  });

  test('dispose 后 update/flush 无效果', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a']);
    clock.tickAll();
    calls.length = 0;

    tracker.dispose();
    calls.length = 0;

    tracker.update(['x', 'y']);
    clock.tickAll();
    expect(calls.length).toBe(0);
  });

  test('快速挂卸（update 未 flush 就 dispose）不产生任何 WS 调用', () => {
    const { client, calls } = makeFakeClient();
    const clock = makeFakeClock();
    const tracker = new SubscriptionTracker(client, 120, clock.schedule, clock.cancel);

    tracker.update(['a', 'b', 'c']);
    tracker.dispose();
    clock.tickAll(); // 即便 tick 也不行，因为 timer 已被 cancel
    expect(calls.length).toBe(0);
  });
});
