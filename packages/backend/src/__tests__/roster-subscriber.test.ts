// Roster subscriber 集成测：真实 in-memory SQLite + 独立 EventBus 实例。
// 不 mock，通过 DB 副作用验证 subscribeRoster 正确响应 instance.* 事件。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from '../bus/events.js';
import { subscribeRoster } from '../bus/subscribers/roster.subscriber.js';
import { closeDb, getDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { roster } from '../roster/roster.js';

// 每个 test 独立 bus + 干净 DB（:memory: 重建）
let bus: EventBus;
let sub: { unsubscribe(): void };

beforeEach(() => {
  closeDb();
  getDb();
  bus = new EventBus();
  sub = subscribeRoster(bus);
  RoleTemplate.create({ name: 'tpl', role: 'w' });
});

afterEach(() => {
  sub.unsubscribe();
  bus.destroy();
  closeDb();
});

describe('subscribeRoster', () => {
  it('instance.created -> roster 有 entry（alias = memberName，status = PENDING）', () => {
    // domain.create 已经插 role_instances 行（status=PENDING），subscriber 只补 alias。
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'alice' });

    bus.emit({
      type: 'instance.created',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      templateName: 'tpl',
      memberName: 'alice',
      isLeader: false,
      teamId: null,
      task: null,
    });

    const entry = roster.get(inst.id);
    expect(entry).not.toBeNull();
    expect(entry!.memberName).toBe('alice');
    expect(entry!.alias).toBe('alice');
    expect(entry!.status).toBe('PENDING');
  });

  it('instance.activated -> roster status 变成 ACTIVE', () => {
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'bob' });

    bus.emit({
      type: 'instance.activated',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      actor: null,
    });

    // 直接查 DB 验证副作用，避免 roster DAO 的任何 fallback。
    const row = getDb()
      .prepare('SELECT status FROM role_instances WHERE id = ?')
      .get(inst.id) as { status: string };
    expect(row.status).toBe('ACTIVE');
  });

  it('instance.offline_requested -> roster status 变成 PENDING_OFFLINE', () => {
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'c' });

    bus.emit({
      type: 'instance.offline_requested',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      requestedBy: 'tester',
    });

    const row = getDb()
      .prepare('SELECT status FROM role_instances WHERE id = ?')
      .get(inst.id) as { status: string };
    expect(row.status).toBe('PENDING_OFFLINE');
  });

  it('instance.deleted -> roster entry 消失', () => {
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'd' });
    expect(roster.get(inst.id)).not.toBeNull();

    bus.emit({
      type: 'instance.deleted',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      previousStatus: 'PENDING',
      force: false,
      teamId: null,
      isLeader: false,
    });

    expect(roster.get(inst.id)).toBeNull();
  });

  it('instance.deleted 对不存在的 instanceId 静默忽略（subscriber 内有 roster.get 预检）', () => {
    // subscriber 自己会在 remove 前 get 一次，不存在就跳过，不抛出也不影响后续事件。
    expect(() =>
      bus.emit({
        type: 'instance.deleted',
        ts: new Date().toISOString(),
        source: 'test',
        instanceId: 'ghost',
        previousStatus: 'PENDING',
        force: false,
        teamId: null,
        isLeader: false,
      }),
    ).not.toThrow();
  });

  it('独立 bus：不同 bus 实例互不串事件', () => {
    // 开一个额外 bus，且 subscribeRoster 只绑定在原来的 bus 上。
    const otherBus = new EventBus();
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'iso' });

    otherBus.emit({
      type: 'instance.activated',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      actor: null,
    });

    // otherBus 没有 subscriber -> DB 状态仍是 PENDING
    const row = getDb()
      .prepare('SELECT status FROM role_instances WHERE id = ?')
      .get(inst.id) as { status: string };
    expect(row.status).toBe('PENDING');
    otherBus.destroy();
  });
});
