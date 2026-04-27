// 验证 /api/panel/{teams,instances,roster,templates} 薄转发：
// 所有 method 应复用底层 handlers 的行为，结果与 /api/{teams,role-instances,roster,role-templates} 一致。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../http/server.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';
import { roster } from '../roster/roster.js';
import type { TeamRow } from '../team/types.js';

const FETCH_TIMEOUT_MS = 3000;

let server: http.Server;
let base: string;

async function req(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
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
    clearTimeout(t);
  }
}

function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

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

describe('/api/panel/teams forwarder', () => {
  it('GET /api/panel/teams -> 200 空数组（与 /api/teams 同）', async () => {
    const a = await req('/api/panel/teams');
    const b = await req('/api/teams');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
    expect((a.body as unknown[]).length).toBe(0);
  });

  it('POST /api/panel/teams -> 201 创建（和 /api/teams POST 行为一致）', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const r = await req('/api/panel/teams', {
      method: 'POST',
      body: { name: 'PT', leaderInstanceId: leaderId },
    });
    expect(r.status).toBe(201);
    const body = r.body as TeamRow;
    expect(body.name).toBe('PT');
    expect(body.leaderInstanceId).toBe(leaderId);
    expect(body.id).toBeTruthy();
  });

  it('GET /api/panel/teams/:id -> 200 详情', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    const created = (
      await req('/api/teams', {
        method: 'POST',
        body: { name: 'T', leaderInstanceId: leaderId },
      })
    ).body as TeamRow;
    const r = await req(`/api/panel/teams/${created.id}`);
    expect(r.status).toBe(200);
    expect((r.body as TeamRow).id).toBe(created.id);
  });

  it('GET /api/panel/teams/:id 不存在 -> 404', async () => {
    const r = await req('/api/panel/teams/ghost');
    expect(r.status).toBe(404);
  });
});

describe('/api/panel/instances forwarder', () => {
  it('GET /api/panel/instances -> 200 数组（与 /api/role-instances 一致）', async () => {
    seedInstance({ member: 'alice', isLeader: true });
    const a = await req('/api/panel/instances');
    const b = await req('/api/role-instances');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
    expect((a.body as unknown[]).length).toBe((b.body as unknown[]).length);
  });

  it('DELETE /api/panel/instances/:id -> 与底层 handler 一致', async () => {
    const id = seedInstance({ member: 'zombie' });
    const r = await req(`/api/panel/instances/${id}?force=1`, { method: 'DELETE' });
    // 不做存在性假设，只校验请求被路由处理（非 404 未命中前缀）
    expect(r.status).not.toBe(404);
  });

  it('DELETE /api/panel/instances/ghost -> 命中转发（与 /api/role-instances/ghost 同）', async () => {
    const a = await req('/api/panel/instances/ghost', { method: 'DELETE' });
    const b = await req('/api/role-instances/ghost', { method: 'DELETE' });
    expect(a.status).toBe(b.status);
  });
});

describe('/api/panel/roster forwarder', () => {
  it('GET /api/panel/roster -> 200 数组（与 /api/roster 一致）', async () => {
    const a = await req('/api/panel/roster');
    const b = await req('/api/roster');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
  });

  it('POST /api/panel/roster 空 body -> 与 /api/roster POST 一致（转发验证）', async () => {
    const a = await req('/api/panel/roster', { method: 'POST', body: {} });
    const b = await req('/api/roster', { method: 'POST', body: {} });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('GET /api/panel/roster/search?q=x -> 与 /api/roster/search 一致', async () => {
    const a = await req('/api/panel/roster/search?q=nomatch');
    const b = await req('/api/roster/search?q=nomatch');
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('PUT /api/panel/roster/:id/alias -> 200 别名（与底层一致）', async () => {
    const id = seedInstance({ member: 'mem2' });
    await req('/api/panel/roster', {
      method: 'POST',
      body: {
        instanceId: id,
        memberName: 'mem2',
        scope: 'local',
        status: 'idle',
        address: 'local://mem2',
      },
    });
    const r = await req(`/api/panel/roster/${id}/alias`, {
      method: 'PUT',
      body: { alias: 'NewAlias' },
    });
    expect(r.status).toBe(200);
    expect((r.body as { alias: string }).alias).toBe('NewAlias');
  });

  it('DELETE /api/panel/roster/ghost -> 与 /api/roster/ghost 一致', async () => {
    const a = await req('/api/panel/roster/ghost', { method: 'DELETE' });
    const b = await req('/api/roster/ghost', { method: 'DELETE' });
    expect(a.status).toBe(b.status);
  });
});

describe('/api/panel/primary-agent forwarder', () => {
  it('GET /api/panel/primary-agent 未配置 -> 200 null（与 /api/primary-agent 一致）', async () => {
    const a = await req('/api/panel/primary-agent');
    const b = await req('/api/primary-agent');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(a.body).toBeNull();
    expect(b.body).toBeNull();
  });

  it('POST /api/panel/primary-agent/config 首次 -> 200 带 id', async () => {
    const r = await req('/api/panel/primary-agent/config', {
      method: 'POST',
      body: { name: 'PanelLeader', cliType: 'claude' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; name: string; cliType: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('PanelLeader');
    expect(body.cliType).toBe('claude');
    expect(body.status).toBe('STOPPED');
  });

  it('POST /api/panel/primary-agent/config 非法字段 -> 400', async () => {
    const r = await req('/api/panel/primary-agent/config', {
      method: 'POST',
      body: { name: '', cliType: 'claude' },
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/panel/primary-agent/stop 未运行 -> 409（与底层一致）', async () => {
    await req('/api/panel/primary-agent/config', {
      method: 'POST',
      body: { name: 'PL2', cliType: 'claude' },
    });
    const a = await req('/api/panel/primary-agent/stop', { method: 'POST' });
    const b = await req('/api/primary-agent/stop', { method: 'POST' });
    expect(a.status).toBe(409);
    expect(a.status).toBe(b.status);
  });

  it('GET /api/panel/primary-agent/config -> 404（GET 不允许，方法校验）', async () => {
    const r = await req('/api/panel/primary-agent/config');
    expect(r.status).toBe(404);
  });
});

describe('/api/panel/cli forwarder', () => {
  it('GET /api/panel/cli -> 200 数组（与 /api/cli 一致）', async () => {
    const a = await req('/api/panel/cli');
    const b = await req('/api/cli');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
    expect((a.body as unknown[]).length).toBe((b.body as unknown[]).length);
  });

  it('POST /api/panel/cli -> 404（GET-only，和底层一致）', async () => {
    const a = await req('/api/panel/cli', { method: 'POST' });
    const b = await req('/api/cli', { method: 'POST' });
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
  });

  it('POST /api/panel/cli/refresh -> 200 数组（与 /api/cli/refresh 一致）', async () => {
    const a = await req('/api/panel/cli/refresh', { method: 'POST' });
    const b = await req('/api/cli/refresh', { method: 'POST' });
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
  });

  it('GET /api/panel/cli/refresh -> 404（方法校验透传）', async () => {
    const r = await req('/api/panel/cli/refresh');
    expect(r.status).toBe(404);
  });
});

describe('/api/panel/templates forwarder', () => {
  it('GET /api/panel/templates -> 200 数组（与 /api/role-templates 一致）', async () => {
    const a = await req('/api/panel/templates');
    const b = await req('/api/role-templates');
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    expect(Array.isArray(a.body)).toBe(true);
  });

  it('POST /api/panel/templates -> 201 创建', async () => {
    const r = await req('/api/panel/templates', {
      method: 'POST',
      body: { name: 'panel-tpl', role: 'worker' },
    });
    expect(r.status).toBe(201);
    expect((r.body as { name: string }).name).toBe('panel-tpl');
  });

  it('GET /api/panel/templates/:name -> 200（PUT 更新后回读一致）', async () => {
    await req('/api/panel/templates', {
      method: 'POST',
      body: { name: 'tpl-x', role: 'r' },
    });
    const put = await req('/api/panel/templates/tpl-x', {
      method: 'PUT',
      body: { description: 'hello' },
    });
    expect(put.status).toBe(200);
    const get = await req('/api/panel/templates/tpl-x');
    expect(get.status).toBe(200);
    expect((get.body as { description: string }).description).toBe('hello');
  });

  it('DELETE /api/panel/templates/ghost -> 与 /api/role-templates/ghost 一致', async () => {
    const a = await req('/api/panel/templates/ghost', { method: 'DELETE' });
    const b = await req('/api/role-templates/ghost', { method: 'DELETE' });
    expect(a.status).toBe(b.status);
  });
});
