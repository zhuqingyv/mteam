// HTTP 集成测试：/api/teams 7 个接口
// 起真实 http.Server（不跑 CommServer / subscribers），用 fetch 打请求验行为。
// 前置实例通过 domain 层直接 create（不经过 PTY spawn），避免外部依赖。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../server.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';
import { roster } from '../roster/roster.js';
import type { TeamRow, TeamMemberRow, TeamWithMembers } from '../team/types.js';

const FETCH_TIMEOUT_MS = 3000;

let server: http.Server;
let base: string;

async function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

// 用 domain 层直接建实例，跳过 PTY spawn。
function seedInstance(params: { member: string; isLeader?: boolean; tpl?: string }): string {
  const tpl = params.tpl ?? 'tpl';
  if (!RoleTemplate.findByName(tpl)) {
    RoleTemplate.create({ name: tpl, role: 'w' });
  }
  const inst = RoleInstance.create({
    templateName: tpl,
    memberName: params.member,
    isLeader: params.isLeader,
  });
  return inst.id;
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  resetAll();
});

describe('HTTP GET /api/teams', () => {
  it('无 team -> 200 空数组', async () => {
    const r = await req('/api/teams');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBe(0);
  });
});

describe('HTTP POST /api/teams', () => {
  it('有 leader instance -> 201 创建', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const r = await req('/api/teams', {
      method: 'POST',
      body: { name: 'T1', leaderInstanceId: leaderId, description: 'desc' },
    });
    expect(r.status).toBe(201);
    const body = r.body as TeamRow;
    expect(body.name).toBe('T1');
    expect(body.leaderInstanceId).toBe(leaderId);
    expect(body.status).toBe('ACTIVE');
    expect(body.description).toBe('desc');
    expect(body.id).toBeTruthy();
  });

  it('缺 name -> 400', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const r = await req('/api/teams', {
      method: 'POST',
      body: { leaderInstanceId: leaderId },
    });
    expect(r.status).toBe(400);
  });

  it('缺 leaderInstanceId -> 400', async () => {
    const r = await req('/api/teams', {
      method: 'POST',
      body: { name: 'T' },
    });
    expect(r.status).toBe(400);
  });
});

describe('HTTP GET /api/teams/:id', () => {
  it('存在 -> 200 详情含 members', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const memberId = seedInstance({ member: 'm1' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: memberId, roleInTeam: 'planner' },
    });

    const r = await req(`/api/teams/${created.id}`);
    expect(r.status).toBe(200);
    const body = r.body as TeamWithMembers;
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('T');
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members.length).toBe(1);
    expect(body.members[0].instanceId).toBe(memberId);
    expect(body.members[0].roleInTeam).toBe('planner');
  });

  it('不存在 -> 404', async () => {
    const r = await req('/api/teams/ghost');
    expect(r.status).toBe(404);
  });
});

describe('HTTP POST /api/teams/:id/members', () => {
  it('添加成员 -> 201', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const memberId = seedInstance({ member: 'm1' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;

    const r = await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: memberId, roleInTeam: 'planner' },
    });
    expect(r.status).toBe(201);
    const body = r.body as { teamId: string; instanceId: string; roleInTeam: string };
    expect(body.teamId).toBe(created.id);
    expect(body.instanceId).toBe(memberId);
    expect(body.roleInTeam).toBe('planner');
  });

  it('缺 instanceId -> 400', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    const r = await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it('team 不存在 -> 404', async () => {
    const r = await req('/api/teams/ghost/members', {
      method: 'POST',
      body: { instanceId: 'x' },
    });
    expect(r.status).toBe(404);
  });
});

describe('HTTP GET /api/teams/:id/members', () => {
  it('有成员 -> 200 成员列表', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const m1 = seedInstance({ member: 'm1' });
    const m2 = seedInstance({ member: 'm2' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: m1 },
    });
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: m2, roleInTeam: 'dev' },
    });

    const r = await req(`/api/teams/${created.id}/members`);
    expect(r.status).toBe(200);
    const body = r.body as TeamMemberRow[];
    expect(body.length).toBe(2);
    const ids = body.map((m) => m.instanceId);
    expect(ids).toContain(m1);
    expect(ids).toContain(m2);
  });

  it('team 不存在 -> 404', async () => {
    const r = await req('/api/teams/ghost/members');
    expect(r.status).toBe(404);
  });
});

describe('HTTP DELETE /api/teams/:id/members/:instanceId', () => {
  it('移除成员 -> 204', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const memberId = seedInstance({ member: 'm1' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: memberId },
    });

    const r = await req(`/api/teams/${created.id}/members/${memberId}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(204);

    const list = await req(`/api/teams/${created.id}/members`);
    expect((list.body as TeamMemberRow[]).length).toBe(0);
  });

  it('team 不存在 -> 404', async () => {
    const r = await req('/api/teams/ghost/members/any', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('成员不存在 -> 仍 204（no-op）', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    const r = await req(`/api/teams/${created.id}/members/ghost`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(204);
  });
});

describe('HTTP POST /api/teams/:id/disband', () => {
  it('ACTIVE team -> 204', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;

    const r = await req(`/api/teams/${created.id}/disband`, { method: 'POST' });
    expect(r.status).toBe(204);

    const after = await req(`/api/teams/${created.id}`);
    expect(after.status).toBe(200);
    expect((after.body as TeamRow).status).toBe('DISBANDED');
  });

  it('team 不存在 -> 404', async () => {
    const r = await req('/api/teams/ghost/disband', { method: 'POST' });
    expect(r.status).toBe(404);
  });
});

describe('HTTP 边界场景', () => {
  it('已解散 team 加成员 -> 409', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const memberId = seedInstance({ member: 'm1' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/disband`, { method: 'POST' });

    const r = await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: memberId },
    });
    expect(r.status).toBe(409);
  });

  it('重复 disband -> 409', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/disband`, { method: 'POST' });

    const r = await req(`/api/teams/${created.id}/disband`, { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('空 team 不自动解散：成员全删后 team 仍 ACTIVE', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const m1 = seedInstance({ member: 'm1' });
    const m2 = seedInstance({ member: 'm2' });
    const created = (await req('/api/teams', {
      method: 'POST',
      body: { name: 'T', leaderInstanceId: leaderId },
    })).body as TeamRow;
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: m1 },
    });
    await req(`/api/teams/${created.id}/members`, {
      method: 'POST',
      body: { instanceId: m2 },
    });
    await req(`/api/teams/${created.id}/members/${m1}`, { method: 'DELETE' });
    await req(`/api/teams/${created.id}/members/${m2}`, { method: 'DELETE' });

    const after = await req(`/api/teams/${created.id}`);
    expect(after.status).toBe(200);
    const body = after.body as TeamWithMembers;
    expect(body.status).toBe('ACTIVE');
    expect(body.members.length).toBe(0);
  });
});
