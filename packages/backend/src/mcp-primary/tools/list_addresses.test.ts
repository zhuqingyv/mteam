// mteam-primary · list_addresses 单测
// 不 mock：:memory: DB + 真实 RoleInstance/Team DAO + 最小 http server 挂 2 个 GET endpoint。
// runListAddresses 只读 /api/role-instances 和 /api/teams，不需要全量 server。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runListAddresses, listAddressesSchema } from './list_addresses.js';
import { closeDb, getDb } from '../../db/connection.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { team } from '../../team/team.js';
import { handleListInstances } from '../../api/panel/role-instances.js';
import { handleListTeams } from '../../api/panel/teams.js';
import type { PrimaryMcpEnv } from '../config.js';

let server: http.Server;
let base: string;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === null ? '' : JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/api/role-instances') {
      const out = handleListInstances();
      sendJson(res, out.status, out.body);
      return;
    }
    if (req.method === 'GET' && url === '/api/teams') {
      const out = handleListTeams();
      sendJson(res, out.status, out.body);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  closeDb();
  getDb();
  if (!RoleTemplate.findByName('tpl')) RoleTemplate.create({ name: 'tpl', role: 'worker' });
});

function env(): PrimaryMcpEnv {
  return { instanceId: 'primary', hubUrl: base };
}

function seedInstance(member: string, isLeader = false): string {
  return RoleInstance.create({ templateName: 'tpl', memberName: member, isLeader }).id;
}

function seedTeam(name: string, leaderId: string): string {
  return team.create({ name, leaderInstanceId: leaderId, description: '' }).id;
}

describe('list_addresses schema', () => {
  it('scope is optional, enum restricted', () => {
    const props = (listAddressesSchema.inputSchema as { properties: Record<string, { enum?: readonly string[] }> }).properties;
    expect(props.scope.enum).toEqual(['all', 'leaders', 'members']);
  });

  it('additionalProperties=false, no required fields', () => {
    const s = listAddressesSchema.inputSchema as { additionalProperties: boolean; required?: string[] };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toBeUndefined();
  });
});

describe('runListAddresses · scope filters', () => {
  it('empty DB → entries=[], total=0', async () => {
    const res = await runListAddresses(env(), {});
    expect(res).toEqual({ entries: [], total: 0 });
  });

  it('scope="all" returns both leaders and members', async () => {
    const leaderA = seedInstance('alice', true);
    const leaderB = seedInstance('bob', true);
    const memberC = seedInstance('carol', false);
    seedTeam('t1', leaderA);
    seedTeam('t2', leaderB);

    const res = await runListAddresses(env(), { scope: 'all' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(3);
    const ids = res.entries.map((e) => e.instanceId).sort();
    expect(ids).toEqual([leaderA, leaderB, memberC].sort());
  });

  it('scope="leaders" returns only leaders', async () => {
    const leaderA = seedInstance('alice', true);
    seedInstance('carol', false);
    seedTeam('t1', leaderA);

    const res = await runListAddresses(env(), { scope: 'leaders' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(1);
    expect(res.entries[0].kind).toBe('leader');
    expect(res.entries[0].instanceId).toBe(leaderA);
  });

  it('scope="members" returns only members', async () => {
    const leaderA = seedInstance('alice', true);
    const memberC = seedInstance('carol', false);
    seedTeam('t1', leaderA);

    const res = await runListAddresses(env(), { scope: 'members' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(1);
    expect(res.entries[0].kind).toBe('member');
    expect(res.entries[0].instanceId).toBe(memberC);
  });

  it('default scope is "all"', async () => {
    const leaderA = seedInstance('alice', true);
    seedInstance('carol', false);
    seedTeam('t1', leaderA);

    const res = await runListAddresses(env(), {});
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(2);
  });

  it('invalid scope falls back to "all"', async () => {
    seedInstance('alice', true);
    seedInstance('carol', false);
    const res = await runListAddresses(env(), { scope: 'garbage' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(2);
  });
});

describe('runListAddresses · teamId filter', () => {
  it('teamId filter returns only that team', async () => {
    const leaderA = seedInstance('alice', true);
    const leaderB = seedInstance('bob', true);
    const memberC = seedInstance('carol', false);
    const memberD = seedInstance('dan', false);
    const teamA = seedTeam('t1', leaderA);
    const teamB = seedTeam('t2', leaderB);
    team.addMember(teamA, memberC, null);
    team.addMember(teamB, memberD, null);

    const res = await runListAddresses(env(), { teamId: teamA });
    if ('error' in res) throw new Error(res.error);
    const ids = res.entries.map((e) => e.instanceId).sort();
    expect(ids).toEqual([leaderA, memberC].sort());
  });

  it('teamId + scope="leaders" intersects both filters', async () => {
    const leaderA = seedInstance('alice', true);
    const memberC = seedInstance('carol', false);
    const teamA = seedTeam('t1', leaderA);
    team.addMember(teamA, memberC, null);

    const res = await runListAddresses(env(), { teamId: teamA, scope: 'leaders' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(1);
    expect(res.entries[0].instanceId).toBe(leaderA);
  });

  it('unknown teamId → entries=[]', async () => {
    seedInstance('alice', true);
    const res = await runListAddresses(env(), { teamId: 'team_not_real' });
    if ('error' in res) throw new Error(res.error);
    expect(res.total).toBe(0);
  });
});

describe('runListAddresses · entry shape', () => {
  it('entry has address, kind, displayName, instanceId, teamId, status', async () => {
    const leaderA = seedInstance('alice', true);
    seedTeam('t1', leaderA);

    const res = await runListAddresses(env(), {});
    if ('error' in res) throw new Error(res.error);
    const e = res.entries[0];
    expect(e.address).toBe(`local:${leaderA}`);
    expect(e.kind).toBe('leader');
    expect(e.displayName).toBe('alice');
    expect(e.instanceId).toBe(leaderA);
    expect(e.status).toBe('PENDING');
    expect(typeof e.teamId === 'string' || e.teamId === null).toBe(true);
  });

  it('leader teamId resolved from teams table when role_instance.teamId is null', async () => {
    const leaderA = seedInstance('alice', true);
    const teamA = seedTeam('t1', leaderA);
    // leader 的 role_instances.team_id 不会自动写入（team.create 不把 leader 加 team_members）
    const res = await runListAddresses(env(), {});
    if ('error' in res) throw new Error(res.error);
    expect(res.entries[0].teamId).toBe(teamA);
  });

  it('member teamId comes from role_instances.teamId (addMember 回填)', async () => {
    const leaderA = seedInstance('alice', true);
    const memberC = seedInstance('carol', false);
    const teamA = seedTeam('t1', leaderA);
    team.addMember(teamA, memberC, null);

    const res = await runListAddresses(env(), { scope: 'members' });
    if ('error' in res) throw new Error(res.error);
    expect(res.entries[0].teamId).toBe(teamA);
  });
});
