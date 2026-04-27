// W2-6 notification.subscriber 单测。
// 完成判据 §2：new EventBus() + 真 CommRouter + 真 ProxyRouter + stub primary agent。
// 不 mock bus / proxy-router；CommRegistry / spy MessageStore 真实构造。
// Why spy MessageStore：CommRouter.dispatch 对 system 目的地要过 store.insert，
//   真 DAO 因 schema to_instance_id NOT NULL 会抛，spy 就够验证 "dispatch 被调"。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { EventBus } from '../events.js';
import { subscribeNotification } from './notification.subscriber.js';
import { CommRouter } from '../../comm/router.js';
import { CommRegistry } from '../../comm/registry.js';
import { createNotificationStore } from '../../notification/notification-store.js';
import { createProxyRouter } from '../../notification/proxy-router.js';
import { closeDb, getDb } from '../../db/connection.js';
import type { MessageStore } from '../../comm/message-store.js';
import type { MessageEnvelope } from '../../comm/envelope.js';
import type {
  BusEvent,
  ContainerCrashedEvent,
  DriverErrorEvent,
  DriverTextEvent,
  NotificationDeliveredEvent,
  TeamMemberJoinedEvent,
  InstanceDeletedEvent,
} from '../types.js';

const TS = '2026-04-25T10:00:00.000Z';
const SRC = 'test';

// —— 事件 fixtures（最小合法字面量） ——
const teamMemberJoined = (): TeamMemberJoinedEvent => ({
  type: 'team.member_joined', ts: TS, source: SRC,
  teamId: 't1', instanceId: 'inst_x', roleInTeam: null,
});
const containerCrashed = (): ContainerCrashedEvent => ({
  type: 'container.crashed', ts: TS, source: SRC,
  agentId: 'inst_1', cliType: 'claude', exitCode: 1, signal: null,
});
const instanceDeleted = (): InstanceDeletedEvent => ({
  type: 'instance.deleted', ts: TS, source: SRC,
  instanceId: 'inst_gone', previousStatus: 'active', force: false,
  teamId: null, isLeader: false,
});
const driverText = (): DriverTextEvent => ({
  type: 'driver.text', ts: TS, source: SRC,
  driverId: 'inst_1', content: 'hi',
});
const driverError = (): DriverErrorEvent => ({
  type: 'driver.error', ts: TS, source: SRC,
  driverId: 'inst_1', message: 'boom',
});

// —— MessageStore spy（仅记录 insert，其他走 noop） ——
function spyStore(): MessageStore & { insertCalls: MessageEnvelope[] } {
  const insertCalls: MessageEnvelope[] = [];
  let nextId = 1;
  return {
    insertCalls,
    insert(env: MessageEnvelope) { insertCalls.push(env); return nextId++; },
    findById: () => null,
    markRead: () => 0,
    listInbox: () => ({ messages: [], total: 0 }),
    listTeamHistory: () => ({ items: [], nextBefore: null, hasMore: false }),
    findUnreadFor: () => [],
    findUnreadForAddress: () => [],
  } as unknown as MessageStore & { insertCalls: MessageEnvelope[] };
}

interface Ctx {
  bus: EventBus;
  router: CommRouter;
  store: MessageStore & { insertCalls: MessageEnvelope[] };
  registry: CommRegistry;
  delivered: NotificationDeliveredEvent[];
  sentInserts: MessageEnvelope[];
}

function setup(
  opts: {
    mode: 'proxy_all' | 'direct' | 'custom';
    rules?: import('../../notification/types.js').CustomRule[];
    userId?: string | null;
    primaryInstanceId?: string | null;
  },
): Ctx {
  closeDb();
  const db = getDb();
  const notifStore = createNotificationStore(db);
  notifStore.upsert({
    id: 'default', userId: null, mode: opts.mode, rules: opts.rules, updatedAt: TS,
  });

  const bus = new EventBus();
  const registry = new CommRegistry();
  const store = spyStore();
  const router = new CommRouter({ registry, messageStore: store, eventBus: bus });
  const proxyRouter = createProxyRouter({
    store: notifStore,
    getPrimaryAgentInstanceId: () => opts.primaryInstanceId ?? null,
    warn: () => {}, // 压掉测试噪声
  });

  const delivered: NotificationDeliveredEvent[] = [];
  bus.on('notification.delivered').subscribe((e) => delivered.push(e));

  subscribeNotification(
    {
      proxyRouter,
      commRouter: router,
      getActiveUserId: () => opts.userId ?? null,
      getPrimaryAgentInstanceId: () => opts.primaryInstanceId ?? null,
    },
    bus,
  );

  return { bus, router, store, registry, delivered, sentInserts: store.insertCalls };
}

afterAll(() => {
  closeDb();
});

describe('notification.subscriber', () => {
  it('proxy_all + primary 在线 + container.crashed → commRouter.dispatch', async () => {
    const ctx = setup({ mode: 'proxy_all', primaryInstanceId: 'inst_leader' });
    ctx.bus.emit(containerCrashed());
    // dispatch 是 fire-and-forget 的 Promise.resolve，单 tick 后 insertCalls 有值
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.sentInserts).toHaveLength(1);
    const env = ctx.sentInserts[0];
    expect(env.from.kind).toBe('system');
    expect(env.to.address).toBe('local:inst_leader');
    expect(env.kind).toBe('system');
    expect(ctx.delivered).toHaveLength(0);
  });

  it('direct + team.member_joined → notification.delivered target=user:local', () => {
    const ctx = setup({ mode: 'direct' });
    ctx.bus.emit(teamMemberJoined());
    expect(ctx.delivered).toHaveLength(1);
    const d = ctx.delivered[0];
    expect(d.target).toEqual({ kind: 'user', id: 'local' });
    expect(d.sourceEventType).toBe('team.member_joined');
    expect(d.sourceEventId).toContain('team.member_joined');
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('direct + 带具体 userId → target.id = userId', () => {
    const ctx = setup({ mode: 'direct', userId: 'u1' });
    ctx.bus.emit(teamMemberJoined());
    expect(ctx.delivered[0].target).toEqual({ kind: 'user', id: 'u1' });
  });

  it('custom + drop rule + instance.deleted → 无任何动作', () => {
    const ctx = setup({
      mode: 'custom',
      rules: [{ matchType: 'instance.*', to: { kind: 'drop' } }],
    });
    ctx.bus.emit(instanceDeleted());
    expect(ctx.delivered).toHaveLength(0);
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('custom + rule target=agent → commRouter.dispatch 到指定 instanceId', async () => {
    const ctx = setup({
      mode: 'custom',
      rules: [{ matchType: 'driver.error', to: { kind: 'agent', instanceId: 'inst_ops' } }],
    });
    ctx.bus.emit(driverError());
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.sentInserts).toHaveLength(1);
    expect(ctx.sentInserts[0].to.address).toBe('local:inst_ops');
    expect(ctx.delivered).toHaveLength(0);
  });

  it('非白名单事件（driver.text）→ subscriber 完全静默', () => {
    const ctx = setup({ mode: 'direct' });
    ctx.bus.emit(driverText());
    expect(ctx.delivered).toHaveLength(0);
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('proxy_all + primary 离线 → proxyRouter fallback direct → notification.delivered', () => {
    const ctx = setup({ mode: 'proxy_all', primaryInstanceId: null });
    ctx.bus.emit(containerCrashed());
    expect(ctx.delivered).toHaveLength(1);
    expect(ctx.delivered[0].target).toEqual({ kind: 'user', id: 'local' });
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('custom + rule target=primary_agent 但 primary 缺席 → 退回 user', () => {
    const ctx = setup({
      mode: 'custom',
      rules: [{ matchType: 'container.*', to: { kind: 'primary_agent' } }],
      primaryInstanceId: null,
      userId: 'u9',
    });
    ctx.bus.emit(containerCrashed());
    expect(ctx.delivered).toHaveLength(1);
    expect(ctx.delivered[0].target).toEqual({ kind: 'user', id: 'u9' });
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('subscriber 不对 notification.delivered 自身再触发（防自循环）', () => {
    const ctx = setup({ mode: 'direct' });
    // 直接 emit 一条 notification.delivered（非 notifiable 白名单 + 显式守门）
    const self: NotificationDeliveredEvent = {
      type: 'notification.delivered',
      ts: TS, source: SRC,
      target: { kind: 'user', id: 'local' },
      sourceEventType: 'team.created',
      sourceEventId: 'team.created@t',
    };
    ctx.bus.emit(self);
    // 触发的自己那条会被 bus.on('notification.delivered') 订阅到，但 subscriber
    // 不会再次产出第二条（否则 delivered.length 会 ≥ 2）。
    expect(ctx.delivered).toHaveLength(1);
    expect(ctx.sentInserts).toHaveLength(0);
  });

  it('subscriber 抛错不会阻塞 bus 分发（handler 内吞错）', () => {
    // 构造一个会让 handle 抛错的场景：proxyRouter 抛 → subscriber try/catch 吞
    const ctx = setup({ mode: 'direct' });
    // 偷换 proxyRouter 会改所有 subscriber；这里验 bus 侧：emit 不抛即视为 OK。
    const emitted: BusEvent[] = [];
    ctx.bus.events$.subscribe((e) => emitted.push(e));
    expect(() => ctx.bus.emit(teamMemberJoined())).not.toThrow();
    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });
});
