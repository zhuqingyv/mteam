// Team DAO 单测：纯 DB 读写语义。
// 测试 team/team.ts 所有方法。不 mock，用 :memory: SQLite。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { Team } from '../team/team.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';

function resetAll(): void {
  closeDb();
  getDb();
  RoleTemplate.create({ name: 'tpl', role: 'w' });
}

function mkInstance(memberName: string, isLeader = false): string {
  return RoleInstance.create({ templateName: 'tpl', memberName, isLeader }).id;
}

describe('Team DAO', () => {
  beforeEach(() => {
    resetAll();
  });

  afterAll(() => {
    closeDb();
  });

  describe('create / findById', () => {
    it('create 返回 TeamRow，DB 有记录', () => {
      const leaderId = mkInstance('leader', true);
      const dao = new Team();
      const created = dao.create({ name: 'T1', leaderInstanceId: leaderId, description: 'd' });
      expect(created.name).toBe('T1');
      expect(created.leaderInstanceId).toBe(leaderId);
      expect(created.status).toBe('ACTIVE');
      expect(created.disbandedAt).toBeNull();
      expect(created.createdAt).toBeTruthy();

      const row = getDb()
        .prepare('SELECT id, name, status FROM teams WHERE id=?')
        .get(created.id) as { id: string; name: string; status: string };
      expect(row.id).toBe(created.id);
      expect(row.name).toBe('T1');
      expect(row.status).toBe('ACTIVE');
    });

    it('findById 存在返回 TeamRow，不存在返回 null', () => {
      const leaderId = mkInstance('leader', true);
      const dao = new Team();
      const t = dao.create({ name: 'T1', leaderInstanceId: leaderId });
      expect(dao.findById(t.id)!.name).toBe('T1');
      expect(dao.findById('ghost')).toBeNull();
    });
  });

  describe('listAll', () => {
    it('返回所有 team，按创建时间倒序', async () => {
      const l1 = mkInstance('l1', true);
      const l2 = mkInstance('l2', true);
      const dao = new Team();
      dao.create({ name: 'A', leaderInstanceId: l1 });
      await new Promise((r) => setTimeout(r, 5));
      dao.create({ name: 'B', leaderInstanceId: l2 });
      const all = dao.listAll();
      expect(all.length).toBe(2);
      expect(all[0].name).toBe('B');
      expect(all[1].name).toBe('A');
    });
  });

  describe('disband', () => {
    it('status 变 disbanded，disbanded_at 有值', () => {
      const leaderId = mkInstance('leader', true);
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.disband(t.id);
      const after = dao.findById(t.id)!;
      expect(after.status).toBe('DISBANDED');
      expect(after.disbandedAt).not.toBeNull();
    });

    it('幂等：disband 已 disbanded 的 team 不报错', () => {
      const leaderId = mkInstance('leader', true);
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.disband(t.id);
      expect(() => dao.disband(t.id)).not.toThrow();
    });
  });

  describe('addMember / removeMember / listMembers', () => {
    it('addMember 写 team_members 且同步 role_instances.team_id', () => {
      const leaderId = mkInstance('leader', true);
      const memberId = mkInstance('m1');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.addMember(t.id, memberId, 'planner');

      const members = dao.listMembers(t.id);
      expect(members.length).toBe(1);
      expect(members[0].instanceId).toBe(memberId);
      expect(members[0].roleInTeam).toBe('planner');

      const row = getDb()
        .prepare('SELECT team_id FROM role_instances WHERE id=?')
        .get(memberId) as { team_id: string };
      expect(row.team_id).toBe(t.id);
    });

    it('addMember 幂等：重复加不报错，role_instances.team_id 仍同步', () => {
      const leaderId = mkInstance('leader', true);
      const memberId = mkInstance('m1');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.addMember(t.id, memberId);
      expect(() => dao.addMember(t.id, memberId)).not.toThrow();
      expect(dao.listMembers(t.id).length).toBe(1);
      const row = getDb()
        .prepare('SELECT team_id FROM role_instances WHERE id=?')
        .get(memberId) as { team_id: string };
      expect(row.team_id).toBe(t.id);
    });

    it('removeMember 删 team_members 且把 role_instances.team_id 置 NULL', () => {
      const leaderId = mkInstance('leader', true);
      const memberId = mkInstance('m1');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.addMember(t.id, memberId);
      dao.removeMember(t.id, memberId);

      expect(dao.listMembers(t.id).length).toBe(0);
      const row = getDb()
        .prepare('SELECT team_id FROM role_instances WHERE id=?')
        .get(memberId) as { team_id: string | null };
      expect(row.team_id).toBeNull();
    });

    it('removeMember 不存在的成员：no-op，不抛错', () => {
      const leaderId = mkInstance('leader', true);
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      expect(() => dao.removeMember(t.id, 'ghost')).not.toThrow();
    });

    it('listMembers 按 joined_at 升序', async () => {
      const leaderId = mkInstance('leader', true);
      const m1 = mkInstance('m1');
      const m2 = mkInstance('m2');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.addMember(t.id, m1);
      await new Promise((r) => setTimeout(r, 5));
      dao.addMember(t.id, m2);
      const members = dao.listMembers(t.id);
      expect(members.map((m) => m.instanceId)).toEqual([m1, m2]);
    });
  });

  describe('findByInstance / countMembers', () => {
    it('findByInstance 返回 instance 所属 team', () => {
      const leaderId = mkInstance('leader', true);
      const memberId = mkInstance('m1');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      dao.addMember(t.id, memberId);
      expect(dao.findByInstance(memberId)!.id).toBe(t.id);
      expect(dao.findByInstance('ghost')).toBeNull();
    });

    it('countMembers 返回正确数量', () => {
      const leaderId = mkInstance('leader', true);
      const m1 = mkInstance('m1');
      const m2 = mkInstance('m2');
      const dao = new Team();
      const t = dao.create({ name: 'T', leaderInstanceId: leaderId });
      expect(dao.countMembers(t.id)).toBe(0);
      dao.addMember(t.id, m1);
      dao.addMember(t.id, m2);
      expect(dao.countMembers(t.id)).toBe(2);
      dao.removeMember(t.id, m1);
      expect(dao.countMembers(t.id)).toBe(1);
    });
  });
});
