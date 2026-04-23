// Roster 单测：纯 DB 读写语义。
// roster 不再维护内存 Map，所有 add/update/get 都操作 role_instances 表。
// 测试前必须先 :memory: 建库 + 造 role_instances 行。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { Roster, roster as rosterSingleton } from '../roster/roster.js';
import type { RosterEntry } from '../roster/types.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';

// 造一个基础 RosterEntry 参数对象。
function mkEntry(partial: Partial<RosterEntry> & { instanceId: string; memberName: string }): RosterEntry {
  return {
    instanceId: partial.instanceId,
    memberName: partial.memberName,
    alias: partial.alias ?? partial.memberName,
    scope: partial.scope ?? 'local',
    status: partial.status ?? 'ACTIVE',
    address: partial.address ?? `local:${partial.instanceId}`,
    teamId: partial.teamId ?? null,
    task: partial.task ?? null,
  };
}

// 每个用例前重建 :memory: DB，并预置 tpl 模板供造实例。
function resetAll(): void {
  closeDb();
  getDb();
  rosterSingleton.reset();
  RoleTemplate.create({ name: 'tpl', role: 'w' });
}

// 直写 role_instances 行，给 roster 测试造固定 id 的实例。
function seedRow(id: string, memberName: string, opts: {
  teamId?: string | null;
  status?: string;
  alias?: string | null;
} = {}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO role_instances (id, template_name, member_name, alias, is_leader, team_id, status, created_at)
       VALUES (?, 'tpl', ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      memberName,
      opts.alias ?? null,
      opts.teamId ?? null,
      opts.status ?? 'ACTIVE',
      now,
    );
}

describe('Roster', () => {
  beforeEach(() => {
    resetAll();
  });

  afterAll(() => {
    closeDb();
  });

  describe('add / get / remove', () => {
    it('行已存在时 add 是 upsert alias 行为，get 能取到最新 alias', () => {
      seedRow('i1', 'alice');
      const r = new Roster();
      r.add(mkEntry({ instanceId: 'i1', memberName: 'alice', alias: 'Alice' }));
      const got = r.get('i1');
      expect(got).not.toBeNull();
      expect(got!.memberName).toBe('alice');
      expect(got!.alias).toBe('Alice');
    });

    it('add 时 alias 为空自动 fallback 为 memberName', () => {
      seedRow('i2', 'bob');
      const r = new Roster();
      r.add(mkEntry({ instanceId: 'i2', memberName: 'bob', alias: '' }));
      const got = r.get('i2');
      expect(got!.alias).toBe('bob');
    });

    it('add 时 role_instances 行不存在 -> 抛错（应先 create 实例）', () => {
      const r = new Roster();
      expect(() => r.add(mkEntry({ instanceId: 'ghost', memberName: 'x' }))).toThrow(
        /not in role_instances/,
      );
    });

    it('get 不存在返回 null', () => {
      const r = new Roster();
      expect(r.get('ghost')).toBeNull();
    });

    it('remove 后 get 返回 null', () => {
      seedRow('i3', 'c');
      const r = new Roster();
      r.remove('i3');
      expect(r.get('i3')).toBeNull();
    });

    it('remove 不存在的 instanceId 抛错', () => {
      const r = new Roster();
      expect(() => r.remove('ghost')).toThrow(/not in roster/);
    });

    it('scope=local 的 add 会同步写 role_instances.alias', () => {
      seedRow('local-1', 'm');
      const r = new Roster();
      r.add(mkEntry({ instanceId: 'local-1', memberName: 'm', alias: 'Malice' }));
      const row = getDb()
        .prepare(`SELECT alias FROM role_instances WHERE id = 'local-1'`)
        .get() as { alias: string | null };
      expect(row.alias).toBe('Malice');
    });
  });

  describe('setAlias', () => {
    it('更新 alias 并同步落 DB', () => {
      seedRow('la-1', 'm');
      const r = new Roster();
      r.setAlias('la-1', '新别名');
      expect(r.get('la-1')!.alias).toBe('新别名');
      const row = getDb()
        .prepare(`SELECT alias FROM role_instances WHERE id = 'la-1'`)
        .get() as { alias: string | null };
      expect(row.alias).toBe('新别名');
    });

    it('不存在的 instanceId 抛错', () => {
      const r = new Roster();
      expect(() => r.setAlias('ghost', 'x')).toThrow(/not in roster/);
    });
  });

  describe('search', () => {
    it('模糊搜索 alias (大小写不敏感)', () => {
      seedRow('i1', 'alice', { alias: 'Alice-Planner' });
      seedRow('i2', 'bob', { alias: 'Bob-Coder' });
      const r = new Roster();
      const result = r.search('i1', 'alice');
      expect(result.match).toBe('unique');
      if (result.match === 'unique') {
        expect(result.target.instanceId).toBe('i1');
      }
    });

    it('多匹配返回 multiple', () => {
      seedRow('i1', 'a', { alias: 'alpha-one' });
      seedRow('i2', 'a2', { alias: 'alpha-two' });
      const r = new Roster();
      const result = r.search('i1', 'alpha');
      expect(result.match).toBe('multiple');
      if (result.match === 'multiple') {
        expect(result.candidates.length).toBe(2);
      }
    });

    it('无匹配返回 none', () => {
      seedRow('i1', 'a');
      const r = new Roster();
      const result = r.search('i1', 'zzz');
      expect(result.match).toBe('none');
    });

    it('空 query 返回 none', () => {
      const r = new Roster();
      const result = r.search('anyone', '');
      expect(result.match).toBe('none');
    });

    it('scope=team 过滤只保留同 teamId 的成员', () => {
      seedRow('c1', 'caller', { teamId: 'team-A', alias: 'caller' });
      seedRow('a', 'alice', { teamId: 'team-A', alias: 'alice' });
      seedRow('b', 'bob', { teamId: 'team-B', alias: 'bob' });
      const r = new Roster();
      const hit = r.search('c1', 'alice', 'team');
      expect(hit.match).toBe('unique');
      const miss = r.search('c1', 'bob', 'team');
      expect(miss.match).toBe('none');
    });

    it('scope=team 但 caller 不在 roster 抛错', () => {
      seedRow('x', 'x', { teamId: 'T' });
      const r = new Roster();
      expect(() => r.search('ghost', 'x', 'team')).toThrow(/not in roster/);
    });

    it('scope=team 但 caller 没有 teamId 返回空', () => {
      seedRow('c1', 'caller', { teamId: null });
      seedRow('a', 'alice');
      const r = new Roster();
      const result = r.search('c1', 'alice', 'team');
      expect(result.match).toBe('none');
    });

    it('未知 scope 抛错', () => {
      seedRow('c', 'c');
      const r = new Roster();
      expect(() => r.search('c', 'x', 'wat' as unknown as 'team')).toThrow(/unknown scope/);
    });
  });

  describe('resolve', () => {
    it('唯一匹配返回 target', () => {
      seedRow('i1', 'alice');
      const r = new Roster();
      const got = r.resolve('i1', 'alice');
      expect(got.instanceId).toBe('i1');
    });

    it('无匹配抛错', () => {
      seedRow('i1', 'alice');
      const r = new Roster();
      expect(() => r.resolve('i1', 'zzz')).toThrow(/no member matches/);
    });

    it('多匹配抛错，消息含候选列表', () => {
      seedRow('i1', 'a', { alias: 'alpha-1' });
      seedRow('i2', 'b', { alias: 'alpha-2' });
      const r = new Roster();
      expect(() => r.resolve('i1', 'alpha')).toThrow(/multiple matches/);
    });
  });

  describe('list', () => {
    it('无 scope 返回全部', () => {
      seedRow('i1', 'a');
      seedRow('i2', 'b');
      const r = new Roster();
      expect(r.list().length).toBe(2);
    });

    it('scope=local 返全部（remote_peers 未实现）', () => {
      seedRow('i1', 'a');
      seedRow('i2', 'b');
      const r = new Roster();
      const got = r.list(undefined, 'local');
      expect(got.length).toBe(2);
    });

    it('scope=remote 返空数组（remote_peers 未实现）', () => {
      seedRow('i1', 'a');
      seedRow('i2', 'b');
      const r = new Roster();
      const got = r.list(undefined, 'remote');
      expect(got.length).toBe(0);
    });

    it('scope=team 过滤同队', () => {
      seedRow('c', 'c', { teamId: 'T' });
      seedRow('a', 'a', { teamId: 'T' });
      seedRow('b', 'b', { teamId: 'U' });
      const r = new Roster();
      const got = r.list('c', 'team');
      const ids = got.map((e) => e.instanceId).sort();
      expect(ids).toEqual(['a', 'c']);
    });
  });

  describe('update', () => {
    it('更新 status / teamId / task 落 DB', () => {
      seedRow('i1', 'a', { status: 'PENDING' });
      const r = new Roster();
      r.update('i1', { status: 'ACTIVE', teamId: 'T9', task: 'do' });
      const got = r.get('i1')!;
      expect(got.status).toBe('ACTIVE');
      expect(got.teamId).toBe('T9');
      expect(got.task).toBe('do');
    });

    it('不存在抛错', () => {
      const r = new Roster();
      expect(() => r.update('ghost', { status: 'X' })).toThrow(/not in roster/);
    });
  });

  describe('与 domain.create 协作', () => {
    it('RoleInstance.create 写入后，roster.get 立即可见，无需先 add', () => {
      // domain 层插行 -> roster 直接 SELECT 就能看到（纯 DB 读）
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const r = new Roster();
      const loaded = r.get(inst.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.memberName).toBe('u');
      expect(loaded!.scope).toBe('local');
      expect(loaded!.address).toBe(`local:${inst.id}`);
    });

    it('Bug #1 回归：domain.create + roster.add 不再抛重复错（幂等 upsert）', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const r = new Roster();
      // 本来会 "already in roster"，现在应静默完成
      expect(() =>
        r.add({
          instanceId: inst.id,
          memberName: inst.memberName,
          alias: inst.memberName,
          scope: 'local',
          status: inst.status,
          address: `local:${inst.id}`,
          teamId: inst.teamId,
          task: inst.task,
        }),
      ).not.toThrow();
    });

    it('Bug #2 回归：roster.update status 会真落 DB', () => {
      const inst = RoleInstance.create({ templateName: 'tpl', memberName: 'u' });
      const r = new Roster();
      r.update(inst.id, { status: 'ACTIVE' });
      const row = getDb()
        .prepare(`SELECT status FROM role_instances WHERE id = ?`)
        .get(inst.id) as { status: string };
      expect(row.status).toBe('ACTIVE');
    });
  });
});
