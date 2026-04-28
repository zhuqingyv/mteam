// setupInstancePanel 核心逻辑单测（S3-G2）。
//
// 验证：
// - 挂载 → addSub + get_turns 各一次
// - 卸载 → removeSub
// - 同 instanceId 两次挂载只拉一次 get_turns（内部去重）
// - 全部卸载后再挂载 → 允许再次拉 get_turns
// - 空 instanceId → no-op

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  setupInstancePanel,
  _resetInstancePanelForTest,
  _getMountCountForTest,
  _isHydratedForTest,
} from '../useInstancePanel';
import type { WsClient } from '../../api/ws-protocol';

type Sent = { op: string; driverId?: string; limit?: number; [k: string]: unknown };

function makeHarness() {
  const added: string[] = [];
  const removed: string[] = [];
  const sent: Sent[] = [];
  const noop = () => {};
  const client: WsClient = {
    send: (msg: object) => { sent.push(msg as Sent); },
    subscribe: noop,
    unsubscribe: noop,
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
  return {
    added,
    removed,
    sent,
    deps: {
      addSub: (id: string) => { added.push(id); },
      removeSub: (id: string) => { removed.push(id); },
      getClient: () => client as WsClient | null,
    },
    nullDeps: {
      addSub: (id: string) => { added.push(id); },
      removeSub: (id: string) => { removed.push(id); },
      getClient: () => null as WsClient | null,
    },
  };
}

beforeEach(() => {
  _resetInstancePanelForTest();
});

describe('setupInstancePanel 单挂载', () => {
  test('挂载触发 addSub + get_turns(instanceId, limit=20)', () => {
    const h = makeHarness();
    const dispose = setupInstancePanel('inst-A', h.deps);
    expect(h.added).toEqual(['inst-A']);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toMatchObject({ op: 'get_turns', driverId: 'inst-A', limit: 20 });
    expect(_getMountCountForTest('inst-A')).toBe(1);
    expect(_isHydratedForTest('inst-A')).toBe(true);
    dispose();
  });

  test('卸载触发 removeSub 并清空计数/hydrated 标记', () => {
    const h = makeHarness();
    const dispose = setupInstancePanel('inst-A', h.deps);
    dispose();
    expect(h.removed).toEqual(['inst-A']);
    expect(_getMountCountForTest('inst-A')).toBe(0);
    expect(_isHydratedForTest('inst-A')).toBe(false);
  });

  test('dispose 幂等：重复调用第二次无副作用', () => {
    const h = makeHarness();
    const dispose = setupInstancePanel('inst-A', h.deps);
    dispose();
    dispose();
    expect(h.removed).toEqual(['inst-A']);
  });

  test('空 instanceId 完全 no-op', () => {
    const h = makeHarness();
    const dispose = setupInstancePanel('', h.deps);
    expect(h.added).toEqual([]);
    expect(h.sent).toEqual([]);
    dispose();
    expect(h.removed).toEqual([]);
  });

  test('client 为 null 时仍登记订阅，只是不发 get_turns', () => {
    const h = makeHarness();
    const dispose = setupInstancePanel('inst-A', h.nullDeps);
    expect(h.added).toEqual(['inst-A']);
    expect(h.sent).toEqual([]);
    dispose();
  });
});

describe('同 instanceId 多次挂载去重', () => {
  test('两次挂载只发一次 get_turns，只 addSub 一次', () => {
    const h = makeHarness();
    const d1 = setupInstancePanel('inst-A', h.deps);
    const d2 = setupInstancePanel('inst-A', h.deps);

    expect(h.added).toEqual(['inst-A']);
    expect(h.sent.length).toBe(1);
    expect(_getMountCountForTest('inst-A')).toBe(2);

    // 第一个 dispose 不应 removeSub —— 还有一个挂载活着
    d1();
    expect(h.removed).toEqual([]);
    expect(_getMountCountForTest('inst-A')).toBe(1);

    // 第二个 dispose 才真正 removeSub
    d2();
    expect(h.removed).toEqual(['inst-A']);
    expect(_getMountCountForTest('inst-A')).toBe(0);
  });

  test('全部卸载后重新挂载 → 再拉一次 get_turns（允许刷新）', () => {
    const h = makeHarness();
    const d1 = setupInstancePanel('inst-A', h.deps);
    d1();

    expect(h.added.length).toBe(1);
    expect(h.removed.length).toBe(1);
    expect(h.sent.length).toBe(1);

    const d2 = setupInstancePanel('inst-A', h.deps);
    expect(h.added.length).toBe(2);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]).toMatchObject({ op: 'get_turns', driverId: 'inst-A', limit: 20 });
    d2();
  });
});

describe('多个 instanceId 并行挂载', () => {
  test('A 和 B 互不影响，各自订阅 + 各自 get_turns', () => {
    const h = makeHarness();
    const dA = setupInstancePanel('inst-A', h.deps);
    const dB = setupInstancePanel('inst-B', h.deps);

    expect(h.added.sort()).toEqual(['inst-A', 'inst-B']);
    expect(h.sent.length).toBe(2);
    const ids = h.sent.map((s) => s.driverId).sort();
    expect(ids).toEqual(['inst-A', 'inst-B']);

    dA();
    expect(h.removed).toEqual(['inst-A']);
    expect(_getMountCountForTest('inst-B')).toBe(1);

    dB();
    expect(h.removed.sort()).toEqual(['inst-A', 'inst-B']);
  });
});
