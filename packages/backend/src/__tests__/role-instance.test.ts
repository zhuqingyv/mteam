// RoleInstance 单测：生命周期 + 状态机集成。
// 使用 :memory: DB。每个用例前 closeDb 重建。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { IllegalTransitionError } from '../domain/state-machine.js';
import { closeDb, getDb } from '../db/connection.js';

// 新建一个 :memory: DB，并插入一条模板以供实例引用（role_instances.template_name 有外键）。
function resetDbWithTemplate(name = 'tpl'): void {
  closeDb();
  getDb(); // 触发建表
  RoleTemplate.create({ name, role: 'worker' });
}

describe('RoleInstance', () => {
  beforeEach(() => {
    resetDbWithTemplate();
  });

  afterAll(() => {
    closeDb();
  });

  describe('create', () => {
    it('创建后状态为 PENDING', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'alice' });
      expect(inst.status).toBe('PENDING');
      expect(inst.templateName).toBe('tpl');
      expect(inst.memberName).toBe('alice');
      expect(inst.id).toBeTruthy();
      expect(inst.sessionId).toBeNull();
      expect(inst.sessionPid).toBeNull();
    });

    it('默认 isLeader=false', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      expect(inst.isLeader).toBe(false);
    });

    it('isLeader=true 被尊重', () => {
      const inst = RoleInstance.create({
        templateName: 'tpl',
        memberName: 'leader',
        isLeader: true,
      });
      expect(inst.isLeader).toBe(true);
    });

    it('外部传入 id 被使用', () => {
      const inst = RoleInstance.create({
        templateName: 'tpl',
        memberName: 'u',
        id: 'fixed-id-001',
      });
      expect(inst.id).toBe('fixed-id-001');
    });

    it('create 会写入一条 role_state_events(create, PENDING)', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const rows = getDb()
        .prepare(`SELECT * FROM role_state_events WHERE instance_id = ?`)
        .all(inst.id) as Array<{ event: string; from_state: string | null; to_state: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.event).toBe('create');
      expect(rows[0]!.from_state).toBeNull();
      expect(rows[0]!.to_state).toBe('PENDING');
    });
  });

  describe('findById / listAll', () => {
    it('findById 存在返回实例', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const got = RoleInstance.findById(inst.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(inst.id);
      expect(got!.status).toBe('PENDING');
    });

    it('findById 不存在返回 null', () => {
      expect(RoleInstance.findById('ghost')).toBeNull();
    });

    it('listAll 空库返回空数组', () => {
      expect(RoleInstance.listAll()).toEqual([]);
    });

    it('listAll 按 created_at DESC 返回', async () => {
      const a = RoleInstance.create({ templateName: 'tpl', memberName: 'a' });
      await new Promise((r) => setTimeout(r, 2));
      const b = RoleInstance.create({ templateName: 'tpl', memberName: 'b' });
      const list = RoleInstance.listAll();
      expect(list.length).toBe(2);
      // DESC = 最新先
      expect(list[0]!.id).toBe(b.id);
      expect(list[1]!.id).toBe(a.id);
    });
  });

  describe('activate', () => {
    it('PENDING -> ACTIVE 成功', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate('leader-1');
      expect(inst.status).toBe('ACTIVE');
      // DB 也同步了
      const reloaded = RoleInstance.findById(inst.id);
      expect(reloaded!.status).toBe('ACTIVE');
    });

    it('已经 ACTIVE 再 activate 应抛 IllegalTransitionError', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate(null);
      expect(() => inst.activate(null)).toThrow(IllegalTransitionError);
    });

    it('activate 会在 role_state_events 写一条 activate 记录', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate('leader-1');
      const rows = getDb()
        .prepare(
          `SELECT * FROM role_state_events WHERE instance_id = ? AND event = 'activate'`,
        )
        .all(inst.id) as Array<{ from_state: string; to_state: string; actor: string | null }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.from_state).toBe('PENDING');
      expect(rows[0]!.to_state).toBe('ACTIVE');
      expect(rows[0]!.actor).toBe('leader-1');
    });
  });

  describe('registerSession', () => {
    it('PENDING -> ACTIVE 并写 session_id/pid', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.registerSession('sess-abc', 12345);
      expect(inst.status).toBe('ACTIVE');
      expect(inst.sessionId).toBe('sess-abc');
      expect(inst.sessionPid).toBe(12345);
      const reloaded = RoleInstance.findById(inst.id);
      expect(reloaded!.sessionId).toBe('sess-abc');
      expect(reloaded!.sessionPid).toBe(12345);
    });

    it('ACTIVE 状态下再 registerSession 应抛 IllegalTransitionError', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate(null);
      expect(() => inst.registerSession('x', 1)).toThrow(IllegalTransitionError);
    });
  });

  describe('requestOffline', () => {
    it('ACTIVE -> PENDING_OFFLINE', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate(null);
      inst.requestOffline('leader-1');
      expect(inst.status).toBe('PENDING_OFFLINE');
    });

    it('PENDING 下 requestOffline 应抛 IllegalTransitionError', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      expect(() => inst.requestOffline('l')).toThrow(IllegalTransitionError);
    });

    it('PENDING_OFFLINE 下再 requestOffline 应抛 IllegalTransitionError', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.activate(null);
      inst.requestOffline('l');
      expect(() => inst.requestOffline('l')).toThrow(IllegalTransitionError);
    });
  });

  describe('delete', () => {
    it('删除后 findById 返回 null、listAll 不包含', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.delete();
      expect(RoleInstance.findById(inst.id)).toBeNull();
      expect(RoleInstance.listAll().map((i) => i.id)).not.toContain(inst.id);
    });

    it('delete 会在 role_state_events 写一条 delete 记录', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const id = inst.id;
      inst.delete();
      const rows = getDb()
        .prepare(
          `SELECT * FROM role_state_events WHERE instance_id = ? AND event = 'delete'`,
        )
        .all(id) as Array<{ to_state: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.to_state).toBe('DELETED');
    });

    it('delete 从任何状态都允许（crash 语义）', () => {
      const a = RoleInstance.create({ templateName: 'tpl', memberName: 'a' });
      expect(() => a.delete()).not.toThrow();

      const b = RoleInstance.create({ templateName: 'tpl', memberName: 'b' });
      b.activate(null);
      expect(() => b.delete()).not.toThrow();

      const c = RoleInstance.create({ templateName: 'tpl', memberName: 'c' });
      c.activate(null);
      c.requestOffline('l');
      expect(() => c.delete()).not.toThrow();
    });
  });

  describe('setter 方法', () => {
    it('setTask / setTeamId / setProjectId / setClaudeSessionId 写 DB', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      inst.setTask('do-something');
      inst.setTeamId('team-1');
      inst.setProjectId('proj-1');
      inst.setClaudeSessionId('claude-s1');
      const reloaded = RoleInstance.findById(inst.id);
      expect(reloaded!.task).toBe('do-something');
      expect(reloaded!.teamId).toBe('team-1');
      expect(reloaded!.projectId).toBe('proj-1');
      expect(reloaded!.claudeSessionId).toBe('claude-s1');
    });
  });

  describe('toJSON', () => {
    it('返回完整 props', () => {
      const inst = RoleInstance.create({
        templateName: 'tpl',
        memberName: 'u',
        isLeader: true,
        task: 'work',
      });
      const json = inst.toJSON();
      expect(json.memberName).toBe('u');
      expect(json.isLeader).toBe(true);
      expect(json.task).toBe('work');
      expect(json.status).toBe('PENDING');
    });
  });
});
