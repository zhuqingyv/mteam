// Team subscriber 测试：独立 EventBus + :memory: SQLite。
// 验证 instance.deleted 事件触发的级联行为（移除成员、空团自动 disband、leader 走 CASCADE）。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from '../bus/events.js';
import { subscribeTeam } from '../bus/subscribers/team.subscriber.js';
import { closeDb, getDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { Team } from '../team/team.js';

let bus: EventBus;
let sub: { unsubscribe(): void };
let dao: Team;

function mkInstance(memberName: string, isLeader = false): string {
  return RoleInstance.create({ templateName: 'tpl', memberName, isLeader }).id;
}

function emitDeleted(instanceId: string): void {
  bus.emit({
    type: 'instance.deleted',
    ts: new Date().toISOString(),
    source: 'test',
    instanceId,
    previousStatus: 'ACTIVE',
    force: false,
  });
}

beforeEach(() => {
  closeDb();
  getDb();
  bus = new EventBus();
  sub = subscribeTeam(bus);
  dao = new Team();
  RoleTemplate.create({ name: 'tpl', role: 'w' });
});

afterEach(() => {
  sub.unsubscribe();
  bus.destroy();
  closeDb();
});

describe('subscribeTeam — instance.deleted 级联', () => {
  it('普通成员：instance.deleted → team_members 行被移除，team 仍在', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);
    // 再加一个成员，确保删除 m1 后 team 不会因为空而被 disband
    const other = mkInstance('m2');
    dao.addMember(t.id, other);

    emitDeleted(memberId);

    const rows = getDb()
      .prepare('SELECT instance_id FROM team_members WHERE team_id=?')
      .all(t.id) as { instance_id: string }[];
    expect(rows.map((r) => r.instance_id).sort()).toEqual([other].sort());

    // team 仍然 active
    const after = dao.findById(t.id)!;
    expect(after.status).toBe('ACTIVE');
  });

  it('最后一个成员 deleted → team 不解散（leader 还在，可再拉人）', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('only');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    emitDeleted(memberId);

    const after = dao.findById(t.id)!;
    expect(after.status).toBe('ACTIVE');
    expect(after.disbandedAt).toBeNull();
    expect(dao.countMembers(t.id)).toBe(0);
  });

  it('leader 被删：CASCADE 物理删 team', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    // 真实物理删 leader —— teams.leader_instance_id 上的 ON DELETE CASCADE 生效
    getDb().prepare('DELETE FROM role_instances WHERE id=?').run(leaderId);
    // 触发 subscriber（subscriber 内部再做一次清理 —— findByInstance 因 team 已消失返回 null，逻辑提前返回）
    emitDeleted(leaderId);

    expect(dao.findById(t.id)).toBeNull();
    const members = getDb()
      .prepare('SELECT instance_id FROM team_members WHERE team_id=?')
      .all(t.id) as { instance_id: string }[];
    expect(members.length).toBe(0);
  });

  it('instance.deleted 对不在任何 team 的 instance：静默不抛', () => {
    const orphan = mkInstance('orphan');
    expect(() => emitDeleted(orphan)).not.toThrow();
  });
});

describe('subscribeTeam — instance.created 级联', () => {
  it('带 teamId 的 instance.created → 自动 addMember', () => {
    const leaderId = mkInstance('leader', true);
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    const memberId = mkInstance('m1');

    bus.emit({
      type: 'instance.created',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: memberId,
      templateName: 'tpl',
      memberName: 'm1',
      isLeader: false,
      teamId: t.id,
      task: null,
    });

    expect(dao.listMembers(t.id).map((m) => m.instanceId)).toEqual([memberId]);
  });

  it('instance.created 无 teamId → 不动任何 team 表', () => {
    const leaderId = mkInstance('leader', true);
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    const memberId = mkInstance('m1');

    bus.emit({
      type: 'instance.created',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: memberId,
      templateName: 'tpl',
      memberName: 'm1',
      isLeader: false,
      teamId: null,
      task: null,
    });

    expect(dao.listMembers(t.id).length).toBe(0);
  });
});
