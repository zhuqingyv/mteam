// HTTP 集成测试：ActionItem 5 个端点（POST/GET 列表/GET 单个/PUT resolve/PUT cancel）。
// 起真实 server 子进程，:memory: DB + 随机端口，fetch 打真实 HTTP。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-action-items-${process.pid}-${PORT}.sock`;
const PID_FILE = `/tmp/test-http-action-items-${process.pid}-${PORT}.pid`;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/panel/action-items`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready within 5s');
}

beforeAll(async () => {
  serverProc = Bun.spawn(['bun', 'run', 'packages/backend/src/http/server.ts'], {
    env: { ...process.env, V2_PORT: String(PORT), TEAM_HUB_V2_DB: ':memory:', TEAM_HUB_COMM_SOCK: SOCK, TEAM_HUB_BACKEND_PID: PID_FILE },
    cwd: '/Users/zhuqingyu/project/mcp-team-hub',
    stdout: 'ignore', stderr: 'ignore',
  });
  await waitReady();
});
afterAll(() => { serverProc?.kill(); });

interface Row { id: string; status: string; title: string; kind: string; deadline: number }

async function request(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET', headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(3000),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function mk(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'task', title: `t-${Date.now()}`, description: 'd',
    assigneeId: 'agent-1', assigneeKind: 'agent',
    creatorId: 'local', creatorKind: 'user',
    deadline: Date.now() + 60_000, ...o,
  };
}

async function postCreate(overrides: Partial<Record<string, unknown>> = {}): Promise<Row> {
  const r = await request('/api/panel/action-items', { method: 'POST', body: mk(overrides) });
  expect(r.status).toBe(201);
  return r.body as Row;
}

describe('HTTP /api/panel/action-items', () => {
  it('POST 创建 → 201 返回 row', async () => {
    const row = await postCreate();
    expect(row.id).toBeDefined();
    expect(row.status).toBe('pending');
    expect(row.kind).toBe('task');
  });

  it('POST 非法 kind → 400', async () => {
    const r = await request('/api/panel/action-items', { method: 'POST', body: mk({ kind: 'bogus' }) });
    expect(r.status).toBe(400);
  });

  it('POST deadline 过近 → 400', async () => {
    const r = await request('/api/panel/action-items', { method: 'POST', body: mk({ deadline: Date.now() }) });
    expect(r.status).toBe(400);
  });

  it('GET 列表 → 200 + items 数组', async () => {
    await postCreate({ assigneeId: 'agent-list', title: 'list-target' });
    const r = await request('/api/panel/action-items?assigneeId=agent-list');
    expect(r.status).toBe(200);
    const body = r.body as { items: Row[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((i) => i.title === 'list-target')).toBe(true);
  });

  it('GET 单个 → 200；不存在 → 404', async () => {
    const { id } = await postCreate({ assigneeId: 'agent-get' });
    const r = await request(`/api/panel/action-items/${id}`);
    expect(r.status).toBe(200);
    expect((r.body as Row).id).toBe(id);
    const miss = await request('/api/panel/action-items/ghost-xyz-404');
    expect(miss.status).toBe(404);
  });

  it('PUT resolve → 200 + status=done；非法 status → 400；不存在 → 404', async () => {
    const { id } = await postCreate({ assigneeId: 'agent-resolve' });
    const bad = await request(`/api/panel/action-items/${id}/resolve`, { method: 'PUT', body: { status: 'bogus' } });
    expect(bad.status).toBe(400);
    const ok = await request(`/api/panel/action-items/${id}/resolve`, { method: 'PUT', body: { status: 'done' } });
    expect(ok.status).toBe(200);
    expect((ok.body as Row).status).toBe('done');
    const miss = await request('/api/panel/action-items/ghost/resolve', { method: 'PUT', body: { status: 'done' } });
    expect(miss.status).toBe(404);
  });

  it('PUT cancel → 200 + status=cancelled；不存在 → 404', async () => {
    const { id } = await postCreate({ assigneeId: 'agent-cancel' });
    const r = await request(`/api/panel/action-items/${id}/cancel`, { method: 'PUT' });
    expect(r.status).toBe(200);
    expect((r.body as Row).status).toBe('cancelled');
    const miss = await request('/api/panel/action-items/ghost/cancel', { method: 'PUT' });
    expect(miss.status).toBe(404);
  });
});
