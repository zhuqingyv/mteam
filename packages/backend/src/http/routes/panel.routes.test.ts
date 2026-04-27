// panel.routes 单测：直接调 handlePanelRoute 验证路径守卫 + 转发正确性。
// 使用真实 DB (in-memory) + domain 层，不 mock handler。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type http from 'node:http';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { handlePanelRoute } from './panel.routes.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { closeDb } from '../../db/connection.js';

function call(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown } | null> {
  const [p, qs] = path.split('?');
  const query = new URLSearchParams(qs ?? '');
  const fakeReq = { headers, method } as unknown as http.IncomingMessage;
  return handlePanelRoute(fakeReq, p, method, query);
}

describe('handlePanelRoute path guard', () => {
  it('non /api/panel/* → null (not consumed)', async () => {
    expect(await call('/api/teams')).toBeNull();
    expect(await call('/api/foo')).toBeNull();
  });

  it('unknown panel sub-path → 404', async () => {
    const r = await call('/api/panel/nonexistent');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });

  it('wrong method on simple endpoint → 404', async () => {
    const r = await call('/api/panel/cli', 'DELETE');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });
});

describe('handlePanelRoute forwarding', () => {
  beforeAll(() => {
    // Seed a template + instance so list endpoints return data.
    RoleTemplate.create({
      name: 'panel-test-tpl',
      role: 'test role',
      availableMcps: [],
    });
    RoleInstance.create({
      templateName: 'panel-test-tpl',
      memberName: 'panel-member',
    });
  });

  afterAll(() => {
    closeDb();
  });

  it('GET /api/panel/teams → 200 + array', async () => {
    const r = await call('/api/panel/teams');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(Array.isArray(r!.body)).toBe(true);
  });

  it('GET /api/panel/instances → 200 + array', async () => {
    const r = await call('/api/panel/instances');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(Array.isArray(r!.body)).toBe(true);
    expect((r!.body as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/panel/templates → 200 + array', async () => {
    const r = await call('/api/panel/templates');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(Array.isArray(r!.body)).toBe(true);
  });

  it('GET /api/panel/roster → 200', async () => {
    const r = await call('/api/panel/roster');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
  });

  it('GET /api/panel/primary-agent → 200', async () => {
    const r = await call('/api/panel/primary-agent');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
  });

  it('GET /api/panel/cli → 200', async () => {
    const r = await call('/api/panel/cli');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
  });

  it('GET /api/panel/mcp/store → 200 + array', async () => {
    const r = await call('/api/panel/mcp/store');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(Array.isArray(r!.body)).toBe(true);
  });

  it('GET /api/panel/mcp/tools → reaches handler (400 without required params)', async () => {
    // handleSearchMcpTools requires instanceId + q; missing params → 400 proves forwarding works.
    const r = await call('/api/panel/mcp/tools');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
    expect((r!.body as { error: string }).error).toContain('instanceId');
  });

  it('GET /api/panel/mcp-tools → reaches /api/mcp-tools/search (400 without params)', async () => {
    const r = await call('/api/panel/mcp-tools');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
    expect((r!.body as { error: string }).error).toContain('instanceId');
  });

  it('GET /api/panel/mcp-tools/search → same handler (400 without params)', async () => {
    const r = await call('/api/panel/mcp-tools/search');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
    expect((r!.body as { error: string }).error).toContain('instanceId');
  });

  it('POST /api/panel/mcp-tools/search → 404 (底层只接 GET)', async () => {
    const r = await call('/api/panel/mcp-tools/search', 'POST');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });

  it('POST /api/panel/messages → reaches /api/messages/send (415 无 Content-Type)', async () => {
    // handleSend 校验 Content-Type=application/json；fakeReq 无 headers → 415，证明已到达底层。
    const r = await call('/api/panel/messages', 'POST');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(415);
  });

  it('GET /api/panel/messages/nonexistent-id → reaches /api/messages/:id (404 消息不存在)', async () => {
    const r = await call('/api/panel/messages/nonexistent-id');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    expect((r!.body as { error: string }).error).toContain('not found');
  });

  it('DELETE /api/panel/messages/send → 404 (底层不接)', async () => {
    const r = await call('/api/panel/messages/send', 'DELETE');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });
});
