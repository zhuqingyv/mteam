// API handler 级单测：直接调用 handler 函数（不起真 HTTP server）。
// 覆盖 role-templates、role-instances（不含 create，避免 PTY）、roster 三组 HTTP 接口。
// 对 createInstance 我们单独用一个可控的 cliBin 外部进程测（见 api-create-instance.test.ts）。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

process.env.TEAM_HUB_V2_DB = ':memory:';

import {
  handleCreateTemplate,
  handleListTemplates,
  handleGetTemplate,
  handleUpdateTemplate,
  handleDeleteTemplate,
} from '../api/panel/role-templates.js';
import {
  handleListInstances,
  handleActivate,
  handleRequestOffline,
  handleDeleteInstance,
} from '../api/panel/role-instances.js';
import {
  handleListRoster,
  handleSearchRoster,
  handleGetRosterEntry,
  handleAddRoster,
  handleUpdateRoster,
  handleSetAlias,
  handleDeleteRoster,
} from '../api/panel/roster.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { roster } from '../roster/roster.js';
import { closeDb, getDb } from '../db/connection.js';

// 整库重置
function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

describe('role-templates API handler', () => {
  beforeEach(() => {
    resetAll();
  });
  afterAll(() => {
    closeDb();
  });

  describe('handleCreateTemplate', () => {
    it('合法 body -> 201 + 模板 JSON', () => {
      const resp = handleCreateTemplate({
        name: 'planner',
        role: 'lead',
        description: '规划',
        persona: 'p',
        availableMcps: [{ name: 'fs', surface: '*', search: '*' }],
      });
      expect(resp.status).toBe(201);
      const body = resp.body as { name: string; role: string };
      expect(body.name).toBe('planner');
      expect(body.role).toBe('lead');
    });

    it('非对象 body -> 400', () => {
      expect(handleCreateTemplate('str' as unknown).status).toBe(400);
      expect(handleCreateTemplate(null).status).toBe(400);
      expect(handleCreateTemplate([]).status).toBe(400);
    });

    it('缺 name -> 400', () => {
      expect(handleCreateTemplate({ role: 'x' }).status).toBe(400);
    });

    it('缺 role -> 400', () => {
      expect(handleCreateTemplate({ name: 'x' }).status).toBe(400);
    });

    it('name 过长 -> 400', () => {
      expect(handleCreateTemplate({ name: 'a'.repeat(65), role: 'x' }).status).toBe(400);
    });

    it('availableMcps 非数组 -> 400', () => {
      expect(
        handleCreateTemplate({ name: 'a', role: 'x', availableMcps: 'nope' }).status,
      ).toBe(400);
    });

    it('availableMcps 含重复 -> 400', () => {
      expect(
        handleCreateTemplate({
          name: 'a',
          role: 'x',
          availableMcps: [
            { name: 'x', surface: '*', search: '*' },
            { name: 'x', surface: '*', search: '*' },
          ],
        }).status,
      ).toBe(400);
    });

    it('重复 name -> 409', () => {
      handleCreateTemplate({ name: 'dup', role: 'x' });
      const resp = handleCreateTemplate({ name: 'dup', role: 'x' });
      expect(resp.status).toBe(409);
    });
  });

  describe('handleListTemplates', () => {
    it('空库 -> 200 空数组', () => {
      const resp = handleListTemplates();
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual([]);
    });

    it('有数据 -> 200 数组', () => {
      handleCreateTemplate({ name: 't1', role: 'r' });
      handleCreateTemplate({ name: 't2', role: 'r' });
      const resp = handleListTemplates();
      expect((resp.body as unknown[]).length).toBe(2);
    });
  });

  describe('handleGetTemplate', () => {
    it('存在 -> 200', () => {
      handleCreateTemplate({ name: 'g1', role: 'r' });
      const resp = handleGetTemplate('g1');
      expect(resp.status).toBe(200);
    });

    it('不存在 -> 404', () => {
      expect(handleGetTemplate('ghost').status).toBe(404);
    });
  });

  describe('handleUpdateTemplate', () => {
    it('存在且合法 -> 200', () => {
      handleCreateTemplate({ name: 'u1', role: 'r' });
      const resp = handleUpdateTemplate('u1', { role: 'lead' });
      expect(resp.status).toBe(200);
      expect((resp.body as { role: string }).role).toBe('lead');
    });

    it('不存在 -> 404', () => {
      expect(handleUpdateTemplate('ghost', { role: 'x' }).status).toBe(404);
    });

    it('非对象 body -> 400', () => {
      handleCreateTemplate({ name: 'u2', role: 'r' });
      expect(handleUpdateTemplate('u2', null).status).toBe(400);
    });

    it('非法 role -> 400', () => {
      handleCreateTemplate({ name: 'u3', role: 'r' });
      expect(handleUpdateTemplate('u3', { role: '' }).status).toBe(400);
    });
  });

  describe('handleDeleteTemplate', () => {
    it('存在 -> 204', () => {
      handleCreateTemplate({ name: 'd1', role: 'r' });
      expect(handleDeleteTemplate('d1').status).toBe(204);
      expect(handleGetTemplate('d1').status).toBe(404);
    });

    it('不存在 -> 404', () => {
      expect(handleDeleteTemplate('ghost').status).toBe(404);
    });
  });
});

describe('role-instances API handler (不经 PTY)', () => {
  beforeEach(() => {
    resetAll();
    // 预置模板，便于创建实例
    RoleTemplate.create({ name: 'tpl', role: 'worker' });
  });
  afterAll(() => {
    closeDb();
  });

  // 工具：用 domain 层造一个 PENDING 实例并入 roster（跳过 driver 和 bus）
  function seedPendingInstance(memberName = 'm', isLeader = false): string {
    const inst = RoleInstance.create({
      templateName: 'tpl',
      memberName,
      isLeader,
    });
    roster.add({
      instanceId: inst.id,
      memberName: inst.memberName,
      alias: inst.memberName,
      scope: 'local',
      status: inst.status,
      address: `local:${inst.id}`,
      teamId: inst.teamId,
      task: inst.task,
    });
    return inst.id;
  }

  describe('handleListInstances', () => {
    it('空库 -> 200 空数组', () => {
      expect(handleListInstances().status).toBe(200);
      expect(handleListInstances().body).toEqual([]);
    });

    it('有数据 -> 200 数组', () => {
      seedPendingInstance('a');
      seedPendingInstance('b');
      const resp = handleListInstances();
      expect((resp.body as unknown[]).length).toBe(2);
    });
  });

  describe('handleActivate', () => {
    it('PENDING 实例 -> 200 ACTIVE', () => {
      const id = seedPendingInstance();
      const resp = handleActivate(id);
      expect(resp.status).toBe(200);
      expect((resp.body as { status: string }).status).toBe('ACTIVE');
    });

    it('不存在 id -> 404', () => {
      expect(handleActivate('ghost').status).toBe(404);
    });

    it('已经 ACTIVE 再 activate -> 409', () => {
      const id = seedPendingInstance();
      handleActivate(id);
      expect(handleActivate(id).status).toBe(409);
    });
  });

  describe('handleRequestOffline', () => {
    it('非 leader 调用 -> 403', () => {
      const memberId = seedPendingInstance('m');
      handleActivate(memberId); // -> ACTIVE
      const nonLeaderId = seedPendingInstance('u', false);
      handleActivate(nonLeaderId);
      const resp = handleRequestOffline(memberId, {}, nonLeaderId);
      expect(resp.status).toBe(403);
    });

    it('leader 调用 -> 200 PENDING_OFFLINE', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      const memberId = seedPendingInstance('m');
      handleActivate(memberId);
      const resp = handleRequestOffline(memberId, {}, leaderId);
      expect(resp.status).toBe(200);
      expect((resp.body as { status: string }).status).toBe('PENDING_OFFLINE');
    });

    it('未激活（PENDING）实例 -> 409', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      const memberId = seedPendingInstance('m');
      // 故意不 activate，保持 PENDING
      const resp = handleRequestOffline(memberId, {}, leaderId);
      expect(resp.status).toBe(409);
    });

    it('不存在的 instance id -> 404', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      expect(handleRequestOffline('ghost', {}, leaderId).status).toBe(404);
    });

    it('不存在的 caller id -> 404', () => {
      const memberId = seedPendingInstance('m');
      handleActivate(memberId);
      expect(handleRequestOffline(memberId, {}, 'ghost-caller').status).toBe(404);
    });

    it('缺 callerInstanceId -> 400', () => {
      const memberId = seedPendingInstance('m');
      handleActivate(memberId);
      // header 和 body 都没带 callerInstanceId
      const resp = handleRequestOffline(memberId, {}, null);
      expect(resp.status).toBe(400);
    });

    it('callerInstanceId 可从 body 取（fallback）', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      const memberId = seedPendingInstance('m');
      handleActivate(memberId);
      // header 不传，body 传 callerInstanceId
      const resp = handleRequestOffline(memberId, { callerInstanceId: leaderId }, null);
      expect(resp.status).toBe(200);
    });
  });

  describe('handleDeleteInstance', () => {
    it('PENDING 实例 -> 204', () => {
      const id = seedPendingInstance();
      expect(handleDeleteInstance(id, false).status).toBe(204);
    });

    it('ACTIVE 实例不带 force -> 409', () => {
      const id = seedPendingInstance();
      handleActivate(id);
      const resp = handleDeleteInstance(id, false);
      expect(resp.status).toBe(409);
    });

    it('ACTIVE 实例 force=true -> 204', () => {
      const id = seedPendingInstance();
      handleActivate(id);
      expect(handleDeleteInstance(id, true).status).toBe(204);
    });

    it('PENDING_OFFLINE 实例 -> 204', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      const id = seedPendingInstance();
      handleActivate(id);
      handleRequestOffline(id, {}, leaderId);
      expect(handleDeleteInstance(id, false).status).toBe(204);
    });

    it('不存在 -> 404', () => {
      expect(handleDeleteInstance('ghost', false).status).toBe(404);
    });
  });

  describe('完整流程：create(PENDING) -> activate -> request-offline -> delete', () => {
    it('流程串通', () => {
      const leaderId = seedPendingInstance('leader', true);
      handleActivate(leaderId);
      const id = seedPendingInstance('m');
      // PENDING -> ACTIVE
      expect((handleActivate(id).body as { status: string }).status).toBe('ACTIVE');
      // ACTIVE -> PENDING_OFFLINE
      const r1 = handleRequestOffline(id, {}, leaderId);
      expect((r1.body as { status: string }).status).toBe('PENDING_OFFLINE');
      // PENDING_OFFLINE -> 删除
      expect(handleDeleteInstance(id, false).status).toBe(204);
    });
  });
});

describe('roster API handler', () => {
  beforeEach(() => {
    resetAll();
    // 纯 DB 语义下 roster=role_instances DAO，所以必须先有模板
    RoleTemplate.create({ name: 'tpl', role: 'w' });
  });
  afterAll(() => {
    closeDb();
  });

  // 造一条真实 role_instances 行（id 由调用方指定），并通过 roster API 同步 alias/teamId/status。
  function addEntry(partial: {
    instanceId: string;
    memberName: string;
    teamId?: string | null;
    alias?: string;
    status?: string;
  }): void {
    const now = new Date().toISOString();
    // 直接写 DB，精确控制 id（domain.create 会随机 uuid）
    getDb()
      .prepare(
        `INSERT INTO role_instances (id, template_name, member_name, is_leader, team_id, status, created_at)
         VALUES (?, 'tpl', ?, 0, ?, ?, ?)`,
      )
      .run(
        partial.instanceId,
        partial.memberName,
        partial.teamId ?? null,
        partial.status ?? 'ACTIVE',
        now,
      );
    // 用 handleAddRoster 走 handler 路径（主要是把 alias 同步到行）
    handleAddRoster({
      instanceId: partial.instanceId,
      memberName: partial.memberName,
      scope: 'local',
      status: partial.status ?? 'ACTIVE',
      address: `local:${partial.instanceId}`,
      alias: partial.alias,
      teamId: partial.teamId ?? null,
    });
  }

  describe('handleAddRoster', () => {
    it('行已存在的 instance -> handler 按约定返回 409（纯 DB 模式下任何 add 都是既有行）', () => {
      // 纯 DB 模式下 roster 就是 role_instances 视图；
      // handler 的 409 等价于"该 id 已在 DB"。
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO role_instances (id, template_name, member_name, is_leader, status, created_at)
           VALUES ('a', 'tpl', 'alice', 0, 'ACTIVE', ?)`,
        )
        .run(now);
      const resp = handleAddRoster({
        instanceId: 'a',
        memberName: 'alice',
        scope: 'local',
        status: 'ACTIVE',
        address: 'local:a',
      });
      expect(resp.status).toBe(409);
    });

    it('缺字段 -> 400', () => {
      expect(handleAddRoster({}).status).toBe(400);
      expect(handleAddRoster({ instanceId: 'x' }).status).toBe(400);
    });

    it('非法 scope -> 400', () => {
      const resp = handleAddRoster({
        instanceId: 'a',
        memberName: 'alice',
        scope: 'wat',
        status: 'ACTIVE',
        address: 'x',
      });
      expect(resp.status).toBe(400);
    });

    it('重复 instanceId -> 409', () => {
      addEntry({ instanceId: 'dup', memberName: 'a' });
      const resp = handleAddRoster({
        instanceId: 'dup',
        memberName: 'a',
        scope: 'local',
        status: 'ACTIVE',
        address: 'local:dup',
      });
      expect(resp.status).toBe(409);
    });
  });

  describe('handleListRoster', () => {
    it('无 scope -> 返全部', () => {
      addEntry({ instanceId: 'a', memberName: 'alice' });
      addEntry({ instanceId: 'b', memberName: 'bob' });
      const resp = handleListRoster(new URLSearchParams());
      expect(resp.status).toBe(200);
      expect((resp.body as unknown[]).length).toBe(2);
    });

    it('scope=team 缺 callerInstanceId -> 400', () => {
      const q = new URLSearchParams({ scope: 'team' });
      expect(handleListRoster(q).status).toBe(400);
    });

    it('scope=local 只返 local', () => {
      // remote_peers 未实现，所以 scope=local 等于全部
      addEntry({ instanceId: 'a', memberName: 'alice' });
      addEntry({ instanceId: 'b', memberName: 'bob' });
      const resp = handleListRoster(new URLSearchParams({ scope: 'local' }));
      expect((resp.body as unknown[]).length).toBe(2);
    });
  });

  describe('handleSearchRoster', () => {
    it('缺 q -> 400', () => {
      expect(handleSearchRoster(new URLSearchParams()).status).toBe(400);
    });

    it('scope=team 缺 caller -> 400', () => {
      expect(
        handleSearchRoster(new URLSearchParams({ q: 'a', scope: 'team' })).status,
      ).toBe(400);
    });

    it('正常搜索 -> 200', () => {
      addEntry({ instanceId: 'a', memberName: 'alice', alias: 'Alice' });
      const resp = handleSearchRoster(
        new URLSearchParams({ q: 'alice', callerInstanceId: 'a' }),
      );
      expect(resp.status).toBe(200);
    });
  });

  describe('handleGetRosterEntry', () => {
    it('存在 -> 200', () => {
      addEntry({ instanceId: 'g1', memberName: 'x' });
      expect(handleGetRosterEntry('g1').status).toBe(200);
    });

    it('不存在 -> 404', () => {
      expect(handleGetRosterEntry('ghost').status).toBe(404);
    });
  });

  describe('handleUpdateRoster', () => {
    it('存在 -> 200', () => {
      addEntry({ instanceId: 'u1', memberName: 'x' });
      const resp = handleUpdateRoster('u1', { status: 'PENDING_OFFLINE' });
      expect(resp.status).toBe(200);
    });

    it('不存在 -> 404', () => {
      expect(handleUpdateRoster('ghost', { status: 'X' }).status).toBe(404);
    });

    it('非对象 body -> 400', () => {
      addEntry({ instanceId: 'u2', memberName: 'x' });
      expect(handleUpdateRoster('u2', null).status).toBe(400);
    });
  });

  describe('handleSetAlias', () => {
    it('存在 -> 200', () => {
      addEntry({ instanceId: 'al1', memberName: 'x' });
      const resp = handleSetAlias('al1', { alias: 'New' });
      expect(resp.status).toBe(200);
    });

    it('缺 alias -> 400', () => {
      addEntry({ instanceId: 'al2', memberName: 'x' });
      expect(handleSetAlias('al2', {}).status).toBe(400);
    });

    it('不存在 -> 404', () => {
      expect(handleSetAlias('ghost', { alias: 'x' }).status).toBe(404);
    });
  });

  describe('handleDeleteRoster', () => {
    it('存在 -> 204', () => {
      addEntry({ instanceId: 'd1', memberName: 'x' });
      expect(handleDeleteRoster('d1').status).toBe(204);
    });

    it('不存在 -> 404', () => {
      expect(handleDeleteRoster('ghost').status).toBe(404);
    });
  });
});
