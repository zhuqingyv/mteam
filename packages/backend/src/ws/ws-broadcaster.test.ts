// W2-2 · ws-broadcaster 单测。
// 规范：不 mock bus。用 `new EventBus()` 隔离、真 SubscriptionManager、
// 真/假 VisibilityFilter（假 filter 仅作为 in-memory 实现，不是 mock 业务）。
// 假 WS 用普通对象模拟 send/readyState，校验下行文本内容。
import { describe, it, expect } from 'bun:test';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';
import type { MessageEnvelope } from '../comm/envelope.js';
import type { MessageStore } from '../comm/message-store.js';
import type {
  ActorPrincipal,
  FilterStore,
  VisibilityRule,
} from '../filter/types.js';
import { createVisibilityFilter } from '../filter/visibility-filter.js';
import { SubscriptionManager } from './subscription-manager.js';
import { WsBroadcaster, toWsPayload, type WsLike } from './ws-broadcaster.js';

/**
 * 假 MessageStore：只实现 findById 用于 enrich 验证，其他方法抛错。
 * 非 mock bus — mock 数据层是 DAO stub，属于测试基础设施，不违反"不 mock bus/业务"规则。
 */
function makeFakeStore(
  map: Record<string, MessageEnvelope | null> = {},
): MessageStore & { findByIdCalls: number } {
  let findByIdCalls = 0;
  const store = {
    get findByIdCalls() {
      return findByIdCalls;
    },
    insert: () => {
      throw new Error('not used in test');
    },
    findById(id: string): MessageEnvelope | null {
      findByIdCalls += 1;
      return map[id] ?? null;
    },
    markRead: () => 0,
    listInbox: () => ({ messages: [], total: 0 }),
    listTeamHistory: () => ({ items: [], nextBefore: null, hasMore: false }),
    findUnreadFor: () => [],
    findUnreadForAddress: () => [],
    findMessagesAfter: () => [],
  } as unknown as MessageStore & { findByIdCalls: number };
  return store;
}

function emptyStoreMock(): MessageStore {
  return makeFakeStore();
}

const OPEN = 1;
const CLOSED = 3;

function makeFakeWs(readyState = OPEN): WsLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

function emptyStore(): FilterStore {
  return {
    list: () => [],
    listForPrincipal: () => [],
    upsert: () => {},
    remove: () => {},
  };
}

function storeWith(rules: VisibilityRule[]): FilterStore {
  return {
    list: () => rules,
    listForPrincipal: (p) =>
      rules.filter((r) => JSON.stringify(r.principal) === JSON.stringify(p)),
    upsert: () => {},
    remove: () => {},
  };
}

function makeMsgEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'comm.message_sent',
    ts: new Date().toISOString(),
    source: 'test',
    messageId: 'msg_abc',
    from: 'agent:inst_x',
    to: 'user:u1',
    ...overrides,
  } as BusEvent;
}

function userP(userId: string): ActorPrincipal {
  return { kind: 'user', userId };
}

describe('WsBroadcaster', () => {
  it('A subscribe team:t1，B subscribe team:t2 → emit comm.message_sent teamId=t1 只推给 A', () => {
    // comm.message_sent 不带 teamId，team 订阅无法命中；用 team.member_joined 更贴近"按 team 订阅"的断言
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const filter = createVisibilityFilter(emptyStore());
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: filter,
      messageStore: emptyStoreMock(),
    });
    b.start();

    const wsA = makeFakeWs();
    const wsB = makeFakeWs();
    mgr.addConn('a');
    mgr.addConn('b');
    mgr.subscribe('a', { scope: 'team', id: 't1' });
    mgr.subscribe('b', { scope: 'team', id: 't2' });
    b.addClient('a', wsA, { principal: userP('u1') });
    b.addClient('b', wsB, { principal: userP('u2') });

    bus.emit({
      type: 'team.member_joined',
      ts: 't',
      source: 'test',
      teamId: 't1',
      instanceId: 'inst_1',
      roleInTeam: null,
    });

    expect(wsA.sent.length).toBe(1);
    expect(wsB.sent.length).toBe(0);
    const parsed = JSON.parse(wsA.sent[0]!);
    expect(parsed.type).toBe('event');
    expect(parsed.event.type).toBe('team.member_joined');
    expect(parsed.event.teamId).toBe('t1');
  });

  it('A subscribe global → 白名单事件都收得到', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: { kind: 'system' } });

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'inst_1',
    });
    expect(ws.sent.length).toBe(2);
  });

  it('A subscribe instance:i1 → 只收 driverId=i1 的 driver 事件', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'instance', id: 'i1' });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'i1',
    });
    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'i2',
    });
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0]!).event.driverId).toBe('i1');
  });

  it('VisibilityFilter deny → drop（订阅命中也不推）', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const rule: VisibilityRule = {
      id: 'r1',
      principal: { kind: 'user', userId: 'u1' },
      target: { kind: 'agent', instanceId: 'inst_leak' },
      effect: 'deny',
      createdAt: new Date().toISOString(),
    };
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(storeWith([rule])),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'inst_leak',
    });
    expect(ws.sent.length).toBe(0);

    // 非 deny target 应该放过
    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'inst_ok',
    });
    expect(ws.sent.length).toBe(1);
  });

  it('下行带 id：comm.* 用 messageId', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'user', id: 'u1' });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit(makeMsgEvent({ type: 'comm.message_sent', messageId: 'msg_42' }));
    const parsed = JSON.parse(ws.sent[0]!);
    expect(parsed.id).toBe('msg_42');
    expect(parsed.event.messageId).toBe('msg_42');
  });

  it('下行带 id：带 eventId 字段的事件用 eventId', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: { kind: 'system' } });

    // A 系列接线后，makeBase 会注入 eventId；测试用 as any 模拟这种未来形态。
    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'i1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ eventId: 'evt_custom_1' } as any),
    } as BusEvent);
    const parsed = JSON.parse(ws.sent[0]!);
    expect(parsed.id).toBe('evt_custom_1');
  });

  it('下行带 id：无 eventId 时兜底生成 UUID（同一事件单次分发内 client 间一致）', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const wsA = makeFakeWs();
    const wsB = makeFakeWs();
    mgr.addConn('a');
    mgr.addConn('b');
    mgr.subscribe('a', { scope: 'global', id: null });
    mgr.subscribe('b', { scope: 'global', id: null });
    b.addClient('a', wsA, { principal: userP('u1') });
    b.addClient('b', wsB, { principal: userP('u2') });

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });

    expect(wsA.sent.length).toBe(1);
    expect(wsB.sent.length).toBe(1);
    const idA = JSON.parse(wsA.sent[0]!).id;
    const idB = JSON.parse(wsB.sent[0]!).id;
    expect(typeof idA).toBe('string');
    expect(idA.length).toBeGreaterThan(0);
    expect(idA).toBe(idB);
  });

  it('下行 payload 剥掉 source / correlationId', () => {
    const payload = toWsPayload({
      type: 'driver.started',
      ts: 't',
      source: 'role-driver',
      correlationId: 'corr_1',
      driverId: 'i1',
    } as BusEvent);
    expect(payload.source).toBeUndefined();
    expect(payload.correlationId).toBeUndefined();
    expect(payload.type).toBe('driver.started');
    expect(payload.driverId).toBe('i1');
  });

  it('readyState !== OPEN 的 client 跳过；不抛', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs(CLOSED);
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });
    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    expect(ws.sent.length).toBe(0);
  });

  it('send 抛异常不影响其他 client', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const wsBad: WsLike = {
      readyState: OPEN,
      send() {
        throw new Error('boom');
      },
    };
    const wsOk = makeFakeWs();
    mgr.addConn('bad');
    mgr.addConn('ok');
    mgr.subscribe('bad', { scope: 'global', id: null });
    mgr.subscribe('ok', { scope: 'global', id: null });
    b.addClient('bad', wsBad, { principal: userP('u1') });
    b.addClient('ok', wsOk, { principal: userP('u2') });

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    expect(wsOk.sent.length).toBe(1);
  });

  it('removeClient 后不再收事件', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    expect(ws.sent.length).toBe(1);

    b.removeClient('a');
    bus.emit({
      type: 'team.disbanded',
      ts: 't',
      source: 'test',
      teamId: 't1',
      reason: 'manual',
    });
    expect(ws.sent.length).toBe(1);
  });

  it('stop 后 bus 事件不再推', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });
    b.stop();

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    expect(ws.sent.length).toBe(0);
  });

  it('非白名单事件不推（WS_EVENT_TYPES 白名单仍生效）', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });

    // 强转一个白名单外的 type，确保被挡。
    bus.emit({
      type: 'comm.message_delivered',
      ts: 't',
      source: 'test',
      messageId: 'msg_1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(ws.sent.length).toBe(0);
  });

  it('start 幂等：重复 start 不重复订阅', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: emptyStoreMock(),
    });
    b.start();
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });
    expect(ws.sent.length).toBe(1);
  });

  // ===== W2-A：comm.* 下行 enrich envelope =====

  function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_abc',
      from: {
        kind: 'agent',
        address: 'local:inst_x',
        displayName: '老王',
        instanceId: 'inst_x',
        memberName: null,
      },
      to: {
        kind: 'user',
        address: 'user:u1',
        displayName: '用户',
        instanceId: null,
        memberName: null,
      },
      teamId: null,
      kind: 'chat',
      summary: '你好',
      content: '你好世界',
      replyTo: null,
      ts: '2026-04-25T00:00:00.000Z',
      readAt: null,
      ...overrides,
    };
  }

  it('W2-A: comm.message_sent 命中 store → payload 带 envelope（summary/content/from.displayName）', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const env = makeEnvelope({ id: 'msg_e1' });
    const store = makeFakeStore({ msg_e1: env });
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: store,
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'user', id: 'u1' });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit(makeMsgEvent({ type: 'comm.message_sent', messageId: 'msg_e1' }));

    expect(ws.sent.length).toBe(1);
    const parsed = JSON.parse(ws.sent[0]!);
    expect(parsed.event.envelope).toBeDefined();
    expect(parsed.event.envelope.summary).toBe('你好');
    expect(parsed.event.envelope.content).toBe('你好世界');
    expect(parsed.event.envelope.from.displayName).toBe('老王');
    expect(parsed.event.envelope.from.instanceId).toBe('inst_x');
    expect(parsed.event.envelope.kind).toBe('chat');
    // bus 原字段依然保留
    expect(parsed.event.messageId).toBe('msg_e1');
    expect(parsed.event.from).toBe('agent:inst_x');
  });

  it('W2-A: comm.message_received 命中 store → envelope.to.displayName + 保留 route 字段', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const env = makeEnvelope({
      id: 'msg_r1',
      to: {
        kind: 'agent',
        address: 'local:inst_y',
        displayName: '小李',
        instanceId: 'inst_y',
        memberName: null,
      },
    });
    const store = makeFakeStore({ msg_r1: env });
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: store,
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    // comm.* 事件不带 instanceId 字段，使用 global 订阅匹配（canSee 默认放行）。
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: { kind: 'system' } });

    bus.emit({
      type: 'comm.message_received',
      ts: 't',
      source: 'test',
      messageId: 'msg_r1',
      from: 'agent:inst_x',
      to: 'agent:inst_y',
      route: 'direct',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(ws.sent.length).toBe(1);
    const parsed = JSON.parse(ws.sent[0]!);
    expect(parsed.event.envelope).toBeDefined();
    expect(parsed.event.envelope.to.displayName).toBe('小李');
    expect(parsed.event.envelope.to.instanceId).toBe('inst_y');
    // route 是 bus 原字段，enrich 不覆盖
    expect(parsed.event.route).toBe('direct');
  });

  it('W2-A: store.findById 返回 null → payload 不含 envelope 字段（fail-soft 不抛）', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const store = makeFakeStore({}); // 空 map，findById 全返 null
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: store,
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'user', id: 'u1' });
    b.addClient('a', ws, { principal: userP('u1') });

    bus.emit(makeMsgEvent({ type: 'comm.message_sent', messageId: 'msg_miss' }));

    expect(ws.sent.length).toBe(1);
    const parsed = JSON.parse(ws.sent[0]!);
    expect(parsed.event.envelope).toBeUndefined();
    expect(parsed.event.messageId).toBe('msg_miss');
  });

  it('W2-A: 非 comm.* 事件 → payload 不含 envelope 字段', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const store = makeFakeStore({
      msg_x: makeEnvelope({ id: 'msg_x' }), // 即使 store 有数据，非 comm 也不 enrich
    });
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: store,
    });
    b.start();
    const ws = makeFakeWs();
    mgr.addConn('a');
    mgr.subscribe('a', { scope: 'global', id: null });
    b.addClient('a', ws, { principal: { kind: 'system' } });

    bus.emit({
      type: 'driver.started',
      ts: 't',
      source: 'test',
      driverId: 'inst_1',
    });
    bus.emit({
      type: 'team.created',
      ts: 't',
      source: 'test',
      teamId: 't1',
      name: 'x',
      leaderInstanceId: 'inst_1',
    });

    expect(ws.sent.length).toBe(2);
    const a = JSON.parse(ws.sent[0]!);
    const b2 = JSON.parse(ws.sent[1]!);
    expect(a.event.envelope).toBeUndefined();
    expect(b2.event.envelope).toBeUndefined();
    // 非 comm 事件 enrich 早退出，findById 不会被调
    expect(store.findByIdCalls).toBe(0);
  });

  it('W2-A R-1: 3 个 client 订阅同一条 comm.message_sent → store.findById 恰好 1 次', () => {
    const bus = new EventBus();
    const mgr = new SubscriptionManager();
    const env = makeEnvelope({ id: 'msg_shared' });
    const store = makeFakeStore({ msg_shared: env });
    const b = new WsBroadcaster({
      eventBus: bus,
      subscriptionManager: mgr,
      visibilityFilter: createVisibilityFilter(emptyStore()),
      messageStore: store,
    });
    b.start();
    const wsA = makeFakeWs();
    const wsB = makeFakeWs();
    const wsC = makeFakeWs();
    mgr.addConn('a');
    mgr.addConn('b');
    mgr.addConn('c');
    mgr.subscribe('a', { scope: 'user', id: 'u1' });
    mgr.subscribe('b', { scope: 'user', id: 'u1' });
    mgr.subscribe('c', { scope: 'user', id: 'u1' });
    b.addClient('a', wsA, { principal: userP('u1') });
    b.addClient('b', wsB, { principal: userP('u1') });
    b.addClient('c', wsC, { principal: userP('u1') });

    bus.emit(makeMsgEvent({ type: 'comm.message_sent', messageId: 'msg_shared' }));

    expect(wsA.sent.length).toBe(1);
    expect(wsB.sent.length).toBe(1);
    expect(wsC.sent.length).toBe(1);
    // 裁决 R-1：enrich 放循环外，3 个 client 共用 1 次 SQL
    expect(store.findByIdCalls).toBe(1);
  });
});
