// comm-notify subscriber 单测：真实 in-memory SQLite + 独立 EventBus + 假 router。
// 不起 comm 服务，router.dispatch 只收集参数供断言。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from '../bus/events.js';
import { subscribeCommNotify } from '../bus/subscribers/comm-notify.subscriber.js';
import { closeDb, getDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import type { CommRouter, DispatchOutcome } from '../comm/router.js';
import type { Message } from '../comm/types.js';

function makeFakeRouter(): { router: CommRouter; sent: Message[] } {
  const sent: Message[] = [];
  const router = {
    dispatch: (msg: Message): DispatchOutcome => {
      sent.push(msg);
      return { route: 'system' };
    },
  } as unknown as CommRouter;
  return { router, sent };
}

let bus: EventBus;
let sub: { unsubscribe(): void };
let router: CommRouter;
let sent: Message[];

beforeEach(() => {
  closeDb();
  getDb();
  bus = new EventBus();
  ({ router, sent } = makeFakeRouter());
  sub = subscribeCommNotify(router, bus);
  RoleTemplate.create({ name: 'tpl', role: 'w' });
});

afterEach(() => {
  sub.unsubscribe();
  bus.destroy();
  closeDb();
});

describe('subscribeCommNotify — instance.activated', () => {
  it('member 激活 → 给 leader 发 "xxx 上线了" 系统消息', () => {
    const leader = RoleInstance.create({
      templateName: 'tpl',
      memberName: 'leader',
      isLeader: true,
    });
    const member = RoleInstance.create({
      templateName: 'tpl',
      memberName: 'alice',
      isLeader: false,
      leaderName: leader.id,
    });

    bus.emit({
      type: 'instance.activated',
      ts: '2026-04-23T00:00:00.000Z',
      source: 'test',
      instanceId: member.id,
      actor: null,
    });

    expect(sent.length).toBe(1);
    const msg = sent[0];
    expect(msg.type).toBe('message');
    expect(msg.from).toBe('local:system');
    expect(msg.to).toBe(`local:${leader.id}`);
    expect(msg.payload.kind).toBe('system');
    expect(msg.payload.action).toBe('member_activated');
    expect(msg.payload.summary).toBe('alice 上线了');
    expect(msg.payload.instanceId).toBe(member.id);
    expect(msg.payload.memberName).toBe('alice');
  });

  it('leader 自己激活 → 不发通知', () => {
    const leader = RoleInstance.create({
      templateName: 'tpl',
      memberName: 'leader',
      isLeader: true,
    });

    bus.emit({
      type: 'instance.activated',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: leader.id,
      actor: null,
    });

    expect(sent.length).toBe(0);
  });

  it('member 没有 leaderName → 不发通知（无从通知谁）', () => {
    const orphan = RoleInstance.create({
      templateName: 'tpl',
      memberName: 'orphan',
      isLeader: false,
      leaderName: null,
    });

    bus.emit({
      type: 'instance.activated',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: orphan.id,
      actor: null,
    });

    expect(sent.length).toBe(0);
  });

  it('instanceId 在 DB 查不到 → 静默不抛', () => {
    expect(() =>
      bus.emit({
        type: 'instance.activated',
        ts: new Date().toISOString(),
        source: 'test',
        instanceId: 'ghost-id',
        actor: null,
      }),
    ).not.toThrow();
    expect(sent.length).toBe(0);
  });

  it('router.dispatch 抛错 → subscriber 吞掉不冒泡', () => {
    const throwingRouter = {
      dispatch: (): DispatchOutcome => {
        throw new Error('boom');
      },
    } as unknown as CommRouter;
    // 换一条订阅用 throwingRouter
    sub.unsubscribe();
    sub = subscribeCommNotify(throwingRouter, bus);

    const leader = RoleInstance.create({
      templateName: 'tpl', memberName: 'leader', isLeader: true,
    });
    const member = RoleInstance.create({
      templateName: 'tpl', memberName: 'm', leaderName: leader.id,
    });

    expect(() =>
      bus.emit({
        type: 'instance.activated',
        ts: new Date().toISOString(),
        source: 'test',
        instanceId: member.id,
        actor: null,
      }),
    ).not.toThrow();
  });
});

describe('subscribeCommNotify — instance.offline_requested（回归）', () => {
  it('emit offline_requested → 给 instance 本人发 deactivate 系统消息', () => {
    const member = RoleInstance.create({ templateName: 'tpl', memberName: 'm' });

    bus.emit({
      type: 'instance.offline_requested',
      ts: '2026-04-23T00:00:00.000Z',
      source: 'test',
      instanceId: member.id,
      requestedBy: 'leader',
    });

    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(`local:${member.id}`);
    expect(sent[0].payload.action).toBe('deactivate');
  });
});
