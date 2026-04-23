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

// 模拟 handleDeleteInstance 的 emit 端：先抓 teamId / isLeader 快照，再 delete。
// subscriber 只信事件 payload，不再回查 findByInstance。
function emitDeleted(instanceId: string): void {
  const snap = RoleInstance.findById(instanceId);
  bus.emit({
    type: 'instance.deleted',
    ts: new Date().toISOString(),
    source: 'test',
    instanceId,
    previousStatus: snap?.status ?? 'ACTIVE',
    force: false,
    teamId: snap?.teamId ?? null,
    isLeader: snap?.isLeader ?? false,
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

// 把 instance 激活到 ACTIVE，便于测试 ACTIVE 成员走 requestOffline 分支。
function activateInstance(id: string): void {
  const inst = RoleInstance.findById(id)!;
  inst.activate(null);
}

function emitOfflineRequested(instanceId: string): void {
  bus.emit({
    type: 'instance.offline_requested',
    ts: new Date().toISOString(),
    source: 'test',
    instanceId,
    requestedBy: 'test',
  });
}

describe('subscribeTeam — instance.offline_requested 级联（Case 1+3）', () => {
  it('普通成员 offline_requested → team_members 移除 + team 仍 ACTIVE', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    activateInstance(memberId);
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    emitOfflineRequested(memberId);

    expect(dao.countMembers(t.id)).toBe(0);
    expect(dao.findById(t.id)!.status).toBe('ACTIVE');
  });

  it('leader offline_requested → 级联 ACTIVE 成员 requestOffline + PENDING 成员 force delete + team disband', () => {
    const leaderId = mkInstance('leader', true);
    activateInstance(leaderId);
    const activeMember = mkInstance('m_active');
    activateInstance(activeMember);
    const pendingMember = mkInstance('m_pending'); // 保持 PENDING
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, activeMember);
    dao.addMember(t.id, pendingMember);

    emitOfflineRequested(leaderId);

    // ACTIVE 成员 → PENDING_OFFLINE（instance 还在）
    expect(RoleInstance.findById(activeMember)!.status).toBe('PENDING_OFFLINE');
    // PENDING 成员 → 直接 delete
    expect(RoleInstance.findById(pendingMember)).toBeNull();
    // team 已 disbanded
    expect(dao.findById(t.id)!.status).toBe('DISBANDED');
  });
});

describe('subscribeTeam — leader instance.deleted 级联成员 force delete（Case 4）', () => {
  it('leader deleted 事件带 teamId+isLeader → 反查 role_instances.team_id 级联删成员', () => {
    // 模拟 handleDeleteInstance：先抓快照，再 CASCADE 删 leader。
    const leaderId = mkInstance('leader', true);
    const m1 = mkInstance('m1');
    const m2 = mkInstance('m2');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, m1);
    dao.addMember(t.id, m2);

    // 抓快照后物理删 leader（CASCADE 清 teams / team_members，但 role_instances.team_id 留着）
    const teamIdSnap = t.id;
    getDb().prepare('DELETE FROM role_instances WHERE id=?').run(leaderId);

    bus.emit({
      type: 'instance.deleted',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: leaderId,
      previousStatus: 'ACTIVE',
      force: true,
      teamId: teamIdSnap,
      isLeader: true,
    });

    // 成员 instance 已被 force delete
    expect(RoleInstance.findById(m1)).toBeNull();
    expect(RoleInstance.findById(m2)).toBeNull();
  });
});

describe('subscribeTeam — team.disbanded 手动解散级联（Case 5）', () => {
  it('team.disbanded(manual) → 成员全部级联下线', () => {
    const leaderId = mkInstance('leader', true);
    const activeMember = mkInstance('m_active');
    activateInstance(activeMember);
    const pendingMember = mkInstance('m_pending');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, activeMember);
    dao.addMember(t.id, pendingMember);

    bus.emit({
      type: 'team.disbanded',
      ts: new Date().toISOString(),
      source: 'test',
      teamId: t.id,
      reason: 'manual',
    });

    expect(RoleInstance.findById(activeMember)!.status).toBe('PENDING_OFFLINE');
    expect(RoleInstance.findById(pendingMember)).toBeNull();
  });

  it('team.disbanded(leader_gone) → 不再重复级联（幂等）', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    // leader_gone 已是级联产物，subscriber 应该跳过不重复处理
    bus.emit({
      type: 'team.disbanded',
      ts: new Date().toISOString(),
      source: 'test',
      teamId: t.id,
      reason: 'leader_gone',
    });

    // member instance 没被动
    expect(RoleInstance.findById(memberId)).not.toBeNull();
  });
});

describe('subscribeTeam — team.member_left 踢人级联（Case 7）', () => {
  it('team.member_left(manual) → 被踢成员级联下线', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    activateInstance(memberId);
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    bus.emit({
      type: 'team.member_left',
      ts: new Date().toISOString(),
      source: 'test',
      teamId: t.id,
      instanceId: memberId,
      reason: 'manual',
    });

    // ACTIVE 成员走 requestOffline → PENDING_OFFLINE
    expect(RoleInstance.findById(memberId)!.status).toBe('PENDING_OFFLINE');
  });

  it('team.member_left(instance_deleted) / (offline_requested) → 不级联（已在上游处理）', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    activateInstance(memberId);
    const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
    dao.addMember(t.id, memberId);

    bus.emit({
      type: 'team.member_left',
      ts: new Date().toISOString(),
      source: 'test',
      teamId: t.id,
      instanceId: memberId,
      reason: 'instance_deleted',
    });

    expect(RoleInstance.findById(memberId)!.status).toBe('ACTIVE');
  });
});
