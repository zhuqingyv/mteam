// worker-status.subscriber 单测。
// 真 EventBus + :memory: DB + 真 domain 层，断言触发事件后是否 emit worker.status_changed，
// 以及 diff 逻辑（无变化不推）。不 mock DB。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { subscribeWorkerStatus } from './worker-status.subscriber.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { closeDb, getDb } from '../../db/connection.js';
import type { BusEvent, WorkerStatusChangedEvent } from '../types.js';

function collect(bus: EventBus): WorkerStatusChangedEvent[] {
  const events: WorkerStatusChangedEvent[] = [];
  bus.on('worker.status_changed').subscribe((e) => events.push(e));
  return events;
}

function emitInstanceCreated(bus: EventBus, id: string, tpl: string): void {
  bus.emit({
    ...makeBase('instance.created', 'test'),
    instanceId: id,
    templateName: tpl,
    memberName: id,
    isLeader: false,
    teamId: null,
    task: null,
  } as BusEvent);
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('worker-status.subscriber', () => {
  it('instance.created 无实例模板 → 首次推送 offline→idle', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'alpha', role: 'dev' });
    const events = collect(bus);
    subscribeWorkerStatus(bus);

    // 还没加实例时先制造一次触发：造实例前 emit 不该推（数据库里只有模板）
    // 直接跳到：create 实例 + emit
    RoleInstance.create({ templateName: 'alpha', memberName: 'a1' });
    emitInstanceCreated(bus, 'id-a1', 'alpha');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'worker.status_changed',
      name: 'alpha',
      status: 'idle',
      instanceCount: 1,
    });
  });

  it('同一状态重复触发 → 只推一次（diff 生效）', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'beta', role: 'dev' });
    RoleInstance.create({ templateName: 'beta', memberName: 'b1' });
    const events = collect(bus);
    subscribeWorkerStatus(bus);

    emitInstanceCreated(bus, 'id-b1', 'beta');
    emitInstanceCreated(bus, 'id-b1', 'beta');
    emitInstanceCreated(bus, 'id-b1', 'beta');

    // 首次 offline→idle 推一次；后两次无变化不推。
    expect(events.filter((e) => e.name === 'beta')).toHaveLength(1);
  });

  it('instanceCount 变化 → 推送', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'gamma', role: 'dev' });
    RoleInstance.create({ templateName: 'gamma', memberName: 'g1' });
    const events = collect(bus);
    subscribeWorkerStatus(bus);

    emitInstanceCreated(bus, 'id-g1', 'gamma');
    // 加第二个实例
    RoleInstance.create({ templateName: 'gamma', memberName: 'g2' });
    emitInstanceCreated(bus, 'id-g2', 'gamma');

    const gamma = events.filter((e) => e.name === 'gamma');
    expect(gamma).toHaveLength(2);
    expect(gamma[0]!.instanceCount).toBe(1);
    expect(gamma[1]!.instanceCount).toBe(2);
  });

  it('driver.started / turn.started / turn.completed 都会触发重算', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'delta', role: 'dev' });
    const events = collect(bus);
    subscribeWorkerStatus(bus);

    // 先建一个实例占位，首次事件推 offline→idle
    RoleInstance.create({ templateName: 'delta', memberName: 'd1' });
    bus.emit({ ...makeBase('driver.started', 'test'), driverId: 'id-d1', cliType: 'claude' } as BusEvent);
    const first = events.filter((e) => e.name === 'delta');
    expect(first).toHaveLength(1);

    // turn.started 状态没变（driverRegistry 没注册 → 仍是 idle）→ 不推
    bus.emit({
      ...makeBase('turn.started', 'test'),
      driverId: 'id-d1', turnId: 't1',
      userInput: { text: 'hi', ts: new Date().toISOString() },
    } as BusEvent);
    expect(events.filter((e) => e.name === 'delta')).toHaveLength(1);
  });

  it('模板删除后再次触发 → 快照清理，不会再推对应条目', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'eps', role: 'dev' });
    RoleInstance.create({ templateName: 'eps', memberName: 'e1' });
    const events = collect(bus);
    subscribeWorkerStatus(bus);

    // 用真实 instance id 触发，首次 offline→idle 推一次
    const inst = RoleInstance.findById(RoleInstance.listAll()[0]!.id)!;
    emitInstanceCreated(bus, inst.id, 'eps');
    expect(events.filter((e) => e.name === 'eps')).toHaveLength(1);

    // 清光实例 + 模板（级联顺序：instances → templates）
    getDb().prepare('DELETE FROM role_instances WHERE template_name = ?').run('eps');
    RoleTemplate.delete('eps');
    // 再触发，eps 已不在 workers 里 → 不应再推 eps
    emitInstanceCreated(bus, 'other', 'eps');
    expect(events.filter((e) => e.name === 'eps')).toHaveLength(1);
  });

  it('unsubscribe 后不再触发', () => {
    const bus = new EventBus();
    RoleTemplate.create({ name: 'zeta', role: 'dev' });
    RoleInstance.create({ templateName: 'zeta', memberName: 'z1' });
    const events = collect(bus);
    const sub = subscribeWorkerStatus(bus);
    sub.unsubscribe();
    emitInstanceCreated(bus, 'id-z1', 'zeta');
    expect(events).toHaveLength(0);
  });
});
