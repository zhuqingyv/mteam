// Team 集成测试：handler → bus → subscriber → DB 副作用全链路。
// 真实 bus（模块单例）+ 真实 subscriber + :memory: SQLite，不 mock。
// 注意：bus 是模块单例，destroy() 后 Subject 永久 complete，
//       所以 boot/teardown 放 beforeAll/afterAll，DB 重置放 beforeEach。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { bootSubscribers, teardownSubscribers } from '../bus/index.js';
import {
  handleCreateTeam,
  handleAddMember,
  handleRemoveMember,
  handleDisbandTeam,
  handleListTeams,
  handleGetTeam,
} from '../api/panel/teams.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';
import type { CommRouter } from '../comm/router.js';
import type { TeamRow, TeamMemberRow } from '../team/types.js';

// comm-notify.subscriber 只调 dispatch；给个 no-op 即可。
const fakeRouter = {
  dispatch: (): { status: 'ok'; delivered: 0 } => ({ status: 'ok', delivered: 0 }),
} as unknown as CommRouter;

function seedTemplate(): void {
  RoleTemplate.create({ name: 'tpl', role: 'worker', persona: 'p', availableMcps: [] });
}

function mkInstance(memberName: string, isLeader = false): string {
  return RoleInstance.create({ templateName: 'tpl', memberName, isLeader }).id;
}

describe('team 集成：handler → bus → subscriber → DB', () => {
  beforeAll(() => {
    bootSubscribers({ commRouter: fakeRouter });
  });
  afterAll(() => {
    teardownSubscribers();
    closeDb();
  });
  beforeEach(() => {
    closeDb();
    getDb();
    seedTemplate();
  });

  it('handleCreateTeam → DB 有 team 行', () => {
    const leaderId = mkInstance('leader', true);
    const resp = handleCreateTeam({
      name: 'Alpha',
      leaderInstanceId: leaderId,
      description: 'd',
    });
    expect(resp.status).toBe(201);
    const created = resp.body as TeamRow;
    expect(created.name).toBe('Alpha');

    const row = getDb()
      .prepare('SELECT id, name, status FROM teams WHERE id=?')
      .get(created.id) as { id: string; name: string; status: string };
    expect(row.name).toBe('Alpha');
    expect(row.status).toBe('ACTIVE');
  });

  it('handleAddMember → team_members 有行 + role_instances.team_id 已同步', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const teamResp = handleCreateTeam({ name: 'T', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;

    const addResp = handleAddMember(teamId, { instanceId: memberId, roleInTeam: 'planner' });
    expect(addResp.status).toBe(201);

    const tmRow = getDb()
      .prepare('SELECT instance_id, role_in_team FROM team_members WHERE team_id=?')
      .get(teamId) as { instance_id: string; role_in_team: string };
    expect(tmRow.instance_id).toBe(memberId);
    expect(tmRow.role_in_team).toBe('planner');

    const riRow = getDb()
      .prepare('SELECT team_id FROM role_instances WHERE id=?')
      .get(memberId) as { team_id: string };
    expect(riRow.team_id).toBe(teamId);
  });

  it('handleRemoveMember → team_members 无行 + role_instances.team_id 清空', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const teamResp = handleCreateTeam({ name: 'T', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;
    handleAddMember(teamId, { instanceId: memberId });

    const rmResp = handleRemoveMember(teamId, memberId);
    expect(rmResp.status).toBe(204);

    const tmRow = getDb()
      .prepare('SELECT id FROM team_members WHERE team_id=? AND instance_id=?')
      .get(teamId, memberId);
    expect(tmRow).toBeNull();

    const riRow = getDb()
      .prepare('SELECT team_id FROM role_instances WHERE id=?')
      .get(memberId) as { team_id: string | null };
    expect(riRow.team_id).toBeNull();
  });

  it('handleDisbandTeam → team status 变 disbanded', () => {
    const leaderId = mkInstance('leader', true);
    const teamResp = handleCreateTeam({ name: 'T', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;

    const disbandResp = handleDisbandTeam(teamId);
    expect(disbandResp.status).toBe(204);

    const row = getDb()
      .prepare('SELECT status, disbanded_at FROM teams WHERE id=?')
      .get(teamId) as { status: string; disbanded_at: string };
    expect(row.status).toBe('DISBANDED');
    expect(row.disbanded_at).toBeTruthy();
  });

  it('handleDisbandTeam 重复调用返回 409', () => {
    const leaderId = mkInstance('leader', true);
    const teamResp = handleCreateTeam({ name: 'T', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;
    handleDisbandTeam(teamId);
    const again = handleDisbandTeam(teamId);
    expect(again.status).toBe(409);
  });

  it('handleListTeams / handleGetTeam 返回正确 shape', () => {
    const leaderId = mkInstance('leader', true);
    const memberId = mkInstance('m1');
    const teamResp = handleCreateTeam({ name: 'Bravo', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;
    handleAddMember(teamId, { instanceId: memberId });

    const list = handleListTeams();
    expect(list.status).toBe(200);
    expect((list.body as TeamRow[]).some((t) => t.id === teamId)).toBe(true);

    const get = handleGetTeam(teamId);
    expect(get.status).toBe(200);
    const body = get.body as TeamRow & { members: TeamMemberRow[] };
    expect(body.name).toBe('Bravo');
    expect(body.members.length).toBe(1);
    expect(body.members[0].instanceId).toBe(memberId);
  });

  it('subscriber 级联：leader 被物理删 → team 通过 CASCADE 消失', () => {
    const leaderId = mkInstance('leader', true);
    const teamResp = handleCreateTeam({ name: 'T', leaderInstanceId: leaderId });
    const teamId = (teamResp.body as TeamRow).id;

    // 物理删 leader，触发 teams.leader_instance_id 的 ON DELETE CASCADE
    getDb().prepare('DELETE FROM role_instances WHERE id=?').run(leaderId);

    const row = getDb().prepare('SELECT id FROM teams WHERE id=?').get(teamId);
    expect(row).toBeNull();
  });
});
