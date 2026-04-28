// Phase 5 W2 · HTTP /api/workflows 集成测试 —— 真实 http.Server + :memory: SQLite。
// 不 boot subscribers，launch 不会 spawn driver，但 DB/团队/成员全部落库，契约可断言。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.TEAM_HUB_V2_DB = ':memory:';
import { createServer } from '../http/server.js';
import { closeDb, getDb } from '../db/connection.js';
import { roster } from '../roster/roster.js';
import { DEFAULT_WORKFLOW_COUNT, ensureDefaultWorkflows } from '../workflow/defaults.js';
import { ensureDefaultTemplates } from '../domain/default-templates.js';

let server: http.Server;
let base: string;

async function req(
  path: string, init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text }; }
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});
beforeEach(() => {
  closeDb(); getDb(); roster.reset();
  ensureDefaultTemplates(); ensureDefaultWorkflows();
});

interface WorkflowRow {
  name: string; label: string; builtin: boolean;
  roles: Array<{ templateName: string; isLeader: boolean }>;
}

describe('GET /api/workflows', () => {
  it('返回 5 个内置模板', async () => {
    const r = await req('/api/workflows');
    expect(r.status).toBe(200);
    const list = r.body as WorkflowRow[];
    expect(list.length).toBe(DEFAULT_WORKFLOW_COUNT);
    const names = list.map((w) => w.name).sort();
    expect(names).toEqual(['bug-fix', 'code-review', 'doc-writing', 'fullstack-team', 'tech-research']);
    for (const w of list) expect(w.builtin).toBe(true);
  });
});

describe('POST /api/workflows', () => {
  it('创建自定义 → 201，builtin=false', async () => {
    const r = await req('/api/workflows', {
      method: 'POST',
      body: {
        name: `custom-${Date.now()}`, label: '自定义',
        roles: [
          { templateName: 'frontend-dev', isLeader: true },
          { templateName: 'backend-dev', isLeader: false },
        ],
      },
    });
    expect(r.status).toBe(201);
    const row = r.body as WorkflowRow;
    expect(row.builtin).toBe(false);
    expect(row.roles).toHaveLength(2);
  });
  it('非法 name / leader 数量 ≠ 1 → 400', async () => {
    const bad = await req('/api/workflows', { method: 'POST', body: { name: 'Bad Name', label: 'x', roles: [] } });
    expect(bad.status).toBe(400);
    const noLeader = await req('/api/workflows', {
      method: 'POST',
      body: { name: `noleader-${Date.now()}`, label: 'x', roles: [{ templateName: 'frontend-dev', isLeader: false }] },
    });
    expect(noLeader.status).toBe(400);
  });
});

describe('POST /api/workflows/:name/launch', () => {
  it('code-review → 201，返回 teamId + leaderId + members', async () => {
    const r = await req('/api/workflows/code-review/launch', {
      method: 'POST', body: { projectName: 'Review PR #42', goal: '审 PR #42' },
    });
    expect(r.status).toBe(201);
    const body = r.body as {
      teamId: string; leaderId: string;
      members: Array<{ templateName: string; instanceId: string }>;
    };
    expect(typeof body.teamId).toBe('string');
    expect(typeof body.leaderId).toBe('string');
    expect(body.members).toHaveLength(1);
    expect(body.members[0].templateName).toBe('qa-engineer');

    const team = await req(`/api/teams/${body.teamId}`);
    expect(team.status).toBe(200);
    const t = team.body as {
      name: string; leaderInstanceId: string; members: Array<{ instanceId: string }>;
    };
    expect(t.name).toBe('Review PR #42');
    expect(t.leaderInstanceId).toBe(body.leaderId);
    expect(t.members.map((m) => m.instanceId)).toContain(body.members[0].instanceId);
  });

  it('缺 goal → 400；不存在的模板 → 404', async () => {
    const noGoal = await req('/api/workflows/code-review/launch', { method: 'POST', body: { projectName: 'X' } });
    expect(noGoal.status).toBe(400);
    const ghost = await req('/api/workflows/ghost-flow/launch', { method: 'POST', body: { projectName: 'X', goal: 'Y' } });
    expect(ghost.status).toBe(404);
  });
});
