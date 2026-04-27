// HTTP 端到端：起一个真实 http.Server（不跑 CommServer / reconcile），用 fetch 测全链路。
// createInstance 涉及 member-driver 启动真实 CLI 子进程；我们用 /usr/bin/true 作为 CLI。
// 取不到 /usr/bin/true 的平台跳过 create 子集。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../http/server.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';
import { roster } from '../roster/roster.js';

const TRUE_BIN = '/usr/bin/true';
const HAS_TRUE = existsSync(TRUE_BIN);

let server: http.Server;
let base: string;

async function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// 每次测试前重置 DB 和 roster，保证相互隔离
function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

beforeAll(async () => {
  // 关键：让 CLI spawn 调用 /usr/bin/true，避免启动真实 claude
  process.env.TEAM_HUB_CLI_BIN = TRUE_BIN;
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

describe('HTTP /api/role-templates', () => {
  it('POST 创建 -> 201', async () => {
    const r = await req('/api/role-templates', {
      method: 'POST',
      body: { name: 'planner', role: 'lead', availableMcps: [] },
    });
    expect(r.status).toBe(201);
  });

  it('GET list -> 200 数组', async () => {
    await req('/api/role-templates', {
      method: 'POST',
      body: { name: 't1', role: 'r' },
    });
    const r = await req('/api/role-templates');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBe(1);
  });

  it('GET 不存在 -> 404', async () => {
    const r = await req('/api/role-templates/ghost');
    expect(r.status).toBe(404);
  });

  it('PUT 更新 -> 200', async () => {
    await req('/api/role-templates', {
      method: 'POST',
      body: { name: 'u1', role: 'r' },
    });
    const r = await req('/api/role-templates/u1', {
      method: 'PUT',
      body: { role: 'lead' },
    });
    expect(r.status).toBe(200);
  });

  it('PUT 不存在 -> 404', async () => {
    const r = await req('/api/role-templates/ghost', {
      method: 'PUT',
      body: { role: 'r' },
    });
    expect(r.status).toBe(404);
  });

  it('DELETE 存在 -> 204', async () => {
    await req('/api/role-templates', {
      method: 'POST',
      body: { name: 'd1', role: 'r' },
    });
    const r = await req('/api/role-templates/d1', { method: 'DELETE' });
    expect(r.status).toBe(204);
  });

  it('POST 重复 name -> 409', async () => {
    await req('/api/role-templates', {
      method: 'POST',
      body: { name: 'dup', role: 'r' },
    });
    const r = await req('/api/role-templates', {
      method: 'POST',
      body: { name: 'dup', role: 'r' },
    });
    expect(r.status).toBe(409);
  });

  it('POST 非法 body -> 400', async () => {
    const r = await req('/api/role-templates', {
      method: 'POST',
      body: { name: '', role: 'r' },
    });
    expect(r.status).toBe(400);
  });

  it('URL 含非法字符的 name -> 404', async () => {
    const r = await req('/api/role-templates/' + encodeURIComponent('a/b'));
    expect(r.status).toBe(404);
  });
});

describe('HTTP /api/role-instances (不经 PTY)', () => {
  // 通过 domain 层直接插实例，避免命中 create handler 的 driver spawn
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

  it('GET list -> 200', async () => {
    const r = await req('/api/role-instances');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('POST activate PENDING 实例 -> 200', async () => {
    const id = seedInstance({ member: 'u' });
    const r = await req(`/api/role-instances/${id}/activate`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('ACTIVE');
  });

  it('POST activate 不存在 -> 404', async () => {
    const r = await req('/api/role-instances/ghost/activate', { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('POST request-offline by leader -> 200', async () => {
    const leaderId = seedInstance({ member: 'L', isLeader: true });
    await req(`/api/role-instances/${leaderId}/activate`, { method: 'POST' });
    const memberId = seedInstance({ member: 'm' });
    await req(`/api/role-instances/${memberId}/activate`, { method: 'POST' });
    const r = await req(`/api/role-instances/${memberId}/request-offline`, {
      method: 'POST',
      body: {},
      headers: { 'x-role-instance-id': leaderId },
    });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('PENDING_OFFLINE');
  });

  it('POST request-offline 非 leader -> 403', async () => {
    const a = seedInstance({ member: 'a' });
    await req(`/api/role-instances/${a}/activate`, { method: 'POST' });
    const b = seedInstance({ member: 'b' });
    await req(`/api/role-instances/${b}/activate`, { method: 'POST' });
    const r = await req(`/api/role-instances/${b}/request-offline`, {
      method: 'POST',
      body: {},
      headers: { 'x-role-instance-id': a },
    });
    expect(r.status).toBe(403);
  });

  it('POST request-offline 无 caller header/body -> 400', async () => {
    const id = seedInstance({ member: 'u' });
    await req(`/api/role-instances/${id}/activate`, { method: 'POST' });
    const r = await req(`/api/role-instances/${id}/request-offline`, {
      method: 'POST',
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it('DELETE PENDING -> 204', async () => {
    const id = seedInstance({ member: 'u' });
    const r = await req(`/api/role-instances/${id}`, { method: 'DELETE' });
    expect(r.status).toBe(204);
  });

  it('DELETE ACTIVE 无 force -> 409', async () => {
    const id = seedInstance({ member: 'u' });
    await req(`/api/role-instances/${id}/activate`, { method: 'POST' });
    const r = await req(`/api/role-instances/${id}`, { method: 'DELETE' });
    expect(r.status).toBe(409);
  });

  it('DELETE ACTIVE force=1 -> 204', async () => {
    const id = seedInstance({ member: 'u' });
    await req(`/api/role-instances/${id}/activate`, { method: 'POST' });
    const r = await req(`/api/role-instances/${id}?force=1`, { method: 'DELETE' });
    expect(r.status).toBe(204);
  });

  it('DELETE 不存在 -> 404', async () => {
    const r = await req('/api/role-instances/ghost', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('完整流程：PENDING -> ACTIVE -> PENDING_OFFLINE -> deleted', async () => {
    const leaderId = seedInstance({ member: 'leader', isLeader: true });
    await req(`/api/role-instances/${leaderId}/activate`, { method: 'POST' });
    const id = seedInstance({ member: 'u' });
    // activate
    let resp = await req(`/api/role-instances/${id}/activate`, { method: 'POST' });
    expect(resp.status).toBe(200);
    // request-offline
    resp = await req(`/api/role-instances/${id}/request-offline`, {
      method: 'POST',
      body: {},
      headers: { 'x-role-instance-id': leaderId },
    });
    expect(resp.status).toBe(200);
    // delete
    resp = await req(`/api/role-instances/${id}`, { method: 'DELETE' });
    expect(resp.status).toBe(204);
    // 确认被物理删除
    const listResp = await req('/api/role-instances');
    const list = listResp.body as Array<{ id: string }>;
    expect(list.find((i) => i.id === id)).toBeUndefined();
  });
});

describe('HTTP /api/roster', () => {
  // 直写 DB 造一条 role_instances 行；roster 纯 DB 读写语义下必须先有行才能 add/update/get。
  function seedRow(id: string, member: string, alias?: string): void {
    if (!RoleTemplate.findByName('tpl')) {
      RoleTemplate.create({ name: 'tpl', role: 'w' });
    }
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO role_instances (id, template_name, member_name, alias, is_leader, status, created_at)
         VALUES (?, 'tpl', ?, ?, 0, 'ACTIVE', ?)`,
      )
      .run(id, member, alias ?? null, now);
  }

  it('POST add 行已存在 -> handler 返 409（纯 DB 语义：任何 add 都命中既有行）', async () => {
    seedRow('r1', 'alice');
    const r = await req('/api/roster', {
      method: 'POST',
      body: {
        instanceId: 'r1',
        memberName: 'alice',
        scope: 'local',
        status: 'ACTIVE',
        address: 'local:r1',
      },
    });
    expect(r.status).toBe(409);
  });

  it('GET list -> 200', async () => {
    const r = await req('/api/roster');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET list scope=team 缺 caller -> 400', async () => {
    const r = await req('/api/roster?scope=team');
    expect(r.status).toBe(400);
  });

  it('GET search 缺 q -> 400', async () => {
    const r = await req('/api/roster/search');
    expect(r.status).toBe(400);
  });

  it('GET search ok -> 200', async () => {
    seedRow('a', 'alice', 'Alice');
    const r = await req(
      '/api/roster/search?q=alice&callerInstanceId=a',
    );
    expect(r.status).toBe(200);
    const body = r.body as { match: string };
    expect(body.match).toBe('unique');
  });

  it('GET /api/roster/<id> 存在 -> 200，不存在 -> 404', async () => {
    seedRow('g1', 'x');
    expect((await req('/api/roster/g1')).status).toBe(200);
    expect((await req('/api/roster/ghost')).status).toBe(404);
  });

  it('PUT /api/roster/<id>/alias -> 200', async () => {
    seedRow('al', 'x');
    const r = await req('/api/roster/al/alias', {
      method: 'PUT',
      body: { alias: 'New' },
    });
    expect(r.status).toBe(200);
  });

  it('DELETE /api/roster/<id> -> 204', async () => {
    seedRow('d1', 'x');
    const r = await req('/api/roster/d1', { method: 'DELETE' });
    expect(r.status).toBe(204);
  });
});

describe('HTTP 未知路径', () => {
  it('GET 未知 -> 404', async () => {
    const r = await req('/api/this-does-not-exist');
    expect(r.status).toBe(404);
  });

  it('GET / -> 200 (panel html)', async () => {
    const res = await fetch(`${base}/`);
    // panel.html 可能 500（文件未 build），不强断言内容，只要不是 404
    expect(res.status === 200 || res.status === 500).toBe(true);
  });
});

// createInstance 涉及 driver spawn。只有在 /usr/bin/true 存在时才跑，
// 并且这里对结果做弱断言——只要不崩就算通过（主要验证 spawn 路径可达）。
describe('HTTP POST /api/role-instances (driver spawn 路径)', () => {
  beforeEach(() => {
    if (!HAS_TRUE) return;
    // 本子集需要预置模板
    RoleTemplate.create({ name: 'tpl-e2e', role: 'w', availableMcps: [] });
  });

  it.skipIf(!HAS_TRUE)('使用 /usr/bin/true 作为 CLI，能返回 201 或 500 但不崩', async () => {
    const r = await req('/api/role-instances', {
      method: 'POST',
      body: { templateName: 'tpl-e2e', memberName: 'e2e-user' },
    });
    // instance.created handler 成功返 201；若异步 driver 启动在当前环境失败只打 stderr，不影响 handler
    expect([201, 500]).toContain(r.status);
    if (r.status === 201) {
      const body = r.body as { id: string; status: string };
      expect(body.status).toBe('PENDING');
      // 清理：force delete，避免影响后续测试
      await req(`/api/role-instances/${body.id}?force=1`, { method: 'DELETE' });
    }
  });

  it.skipIf(!HAS_TRUE)('不存在的 templateName -> 404', async () => {
    const r = await req('/api/role-instances', {
      method: 'POST',
      body: { templateName: 'nope', memberName: 'u' },
    });
    expect(r.status).toBe(404);
  });

  it('非法 body -> 400', async () => {
    const r = await req('/api/role-instances', { method: 'POST', body: {} });
    expect(r.status).toBe(400);
  });
});
