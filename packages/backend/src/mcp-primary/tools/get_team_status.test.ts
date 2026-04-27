// get_team_status 集成测试：:memory: DB + 真实 HTTP server，不 mock。
// 建 team + leader + members，调 runGetTeamStatus，验证返回形状。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../../http/server.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { team } from '../../team/team.js';
import { closeDb, getDb } from '../../db/connection.js';
import { roster } from '../../roster/roster.js';
import type { PrimaryMcpEnv } from '../config.js';
import { runGetTeamStatus } from './get_team_status.js';

let server: http.Server;
let env: PrimaryMcpEnv;

function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

function seedInstance(params: {
  member: string;
  isLeader?: boolean;
  task?: string | null;
}): string {
  const tpl = 'tpl';
  if (!RoleTemplate.findByName(tpl)) RoleTemplate.create({ name: tpl, role: 'w' });
  const inst = RoleInstance.create({
    templateName: tpl,
    memberName: params.member,
    isLeader: params.isLeader,
    task: params.task ?? null,
  });
  return inst.id;
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  env = { instanceId: 'primary', hubUrl: `http://127.0.0.1:${addr.port}` };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  resetAll();
});

describe('runGetTeamStatus', () => {
  it('返回 teamName + leader + members + memberCount', async () => {
    const leaderId = seedInstance({ member: 'alice', isLeader: true });
    const m1 = seedInstance({ member: 'bob', task: 'write tests' });
    const m2 = seedInstance({ member: 'carol' });
    const t = team.create({ name: 'T1', leaderInstanceId: leaderId, description: '' });
    team.addMember(t.id, leaderId);
    team.addMember(t.id, m1, 'dev');
    team.addMember(t.id, m2);

    const res = (await runGetTeamStatus(env, { teamId: t.id })) as {
      teamName: string;
      leader: { name: string; status: string; task?: string };
      members: Array<{ name: string; status: string; task?: string }>;
      memberCount: number;
    };
    expect(res.teamName).toBe('T1');
    expect(res.leader.name).toBe('alice');
    expect(res.leader.status).toBe('PENDING');
    expect(res.memberCount).toBe(3);
    expect(res.members.map((m) => m.name).sort()).toEqual(['bob', 'carol']);
    const bob = res.members.find((m) => m.name === 'bob')!;
    expect(bob.task).toBe('write tests');
    const carol = res.members.find((m) => m.name === 'carol')!;
    expect(carol.task).toBeUndefined();
  });

  it('缺 teamId → error', async () => {
    const res = (await runGetTeamStatus(env, {})) as { error: string };
    expect(res.error).toContain('teamId');
  });

  it('teamId 不存在 → error 不抛', async () => {
    const res = (await runGetTeamStatus(env, { teamId: 'ghost' })) as { error: string };
    expect(typeof res.error).toBe('string');
  });

  it('只有 leader 无成员 → memberCount=1 且 members=[]', async () => {
    const leaderId = seedInstance({ member: 'solo', isLeader: true });
    const t = team.create({ name: 'Solo', leaderInstanceId: leaderId, description: '' });
    team.addMember(t.id, leaderId);
    const res = (await runGetTeamStatus(env, { teamId: t.id })) as {
      leader: { name: string };
      members: unknown[];
      memberCount: number;
    };
    expect(res.leader.name).toBe('solo');
    expect(res.members).toEqual([]);
    expect(res.memberCount).toBe(1);
  });

  it('teamId 被 URL-encode', async () => {
    const res = (await runGetTeamStatus(env, { teamId: 'a/b c' })) as { error: string };
    expect(typeof res.error).toBe('string');
  });
});
