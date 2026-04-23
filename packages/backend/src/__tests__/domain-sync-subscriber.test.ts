// domain-sync subscriber 集成测：真实 in-memory SQLite + 独立 EventBus。
// 验证 pty.spawned 事件会把 pid 回写到 role_instances.session_pid。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from '../bus/events.js';
import { subscribeDomainSync } from '../bus/subscribers/domain-sync.subscriber.js';
import { closeDb, getDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';

let bus: EventBus;
let sub: { unsubscribe(): void };

beforeEach(() => {
  closeDb();
  getDb();
  bus = new EventBus();
  sub = subscribeDomainSync(bus);
  RoleTemplate.create({ name: 'tpl', role: 'w' });
});

afterEach(() => {
  sub.unsubscribe();
  bus.destroy();
  closeDb();
});

describe('subscribeDomainSync', () => {
  it('pty.spawned -> instance.sessionPid 已回写到 DB', () => {
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'alice' });
    // 初始状态：session_pid 是 NULL
    const before = getDb()
      .prepare('SELECT session_pid FROM role_instances WHERE id = ?')
      .get(inst.id) as { session_pid: number | null };
    expect(before.session_pid).toBeNull();

    bus.emit({
      type: 'pty.spawned',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      pid: 99999,
    });

    const after = getDb()
      .prepare('SELECT session_pid FROM role_instances WHERE id = ?')
      .get(inst.id) as { session_pid: number | null };
    expect(after.session_pid).toBe(99999);
  });

  it('pty.spawned 对不存在的 instanceId 静默处理（subscriber 打 stderr，不抛）', () => {
    expect(() =>
      bus.emit({
        type: 'pty.spawned',
        ts: new Date().toISOString(),
        source: 'test',
        instanceId: 'ghost',
        pid: 1,
      }),
    ).not.toThrow();
  });

  it('多次 pty.spawned 会覆盖为最新 pid', () => {
    const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'b' });
    bus.emit({
      type: 'pty.spawned',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      pid: 111,
    });
    bus.emit({
      type: 'pty.spawned',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: inst.id,
      pid: 222,
    });
    const row = getDb()
      .prepare('SELECT session_pid FROM role_instances WHERE id = ?')
      .get(inst.id) as { session_pid: number | null };
    expect(row.session_pid).toBe(222);
  });
});
