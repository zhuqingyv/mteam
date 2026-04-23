// HTTP 集成测试：/api/sessions/register。
// 起独立 server 子进程，:memory: DB + 随机端口。用 TEAM_HUB_CLI_BIN=/usr/bin/true 让 pty 不真实拉起 claude。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-sessions-${process.pid}-${PORT}.sock`;
const TRUE_BIN = '/usr/bin/true';
const HAS_TRUE = existsSync(TRUE_BIN);
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/role-templates`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready within 5s');
}

beforeAll(async () => {
  serverProc = Bun.spawn(['bun', 'run', 'packages/backend/src/server.ts'], {
    env: {
      ...process.env,
      V2_PORT: String(PORT),
      TEAM_HUB_V2_DB: ':memory:',
      TEAM_HUB_COMM_SOCK: SOCK,
      TEAM_HUB_CLI_BIN: TRUE_BIN,
    },
    cwd: '/Users/zhuqingyu/project/mcp-team-hub',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitReady();
});

afterAll(() => {
  serverProc?.kill();
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

describe('HTTP /api/sessions/register', () => {
  it('POST register → 200 + 自动 activate', async () => {
    if (!HAS_TRUE) return;
    // 先建一个 template 和一个 PENDING 实例
    const tplName = `sess-tpl-${Date.now()}`;
    await post('/api/role-templates', { name: tplName, role: 'dev' });
    const instRes = await post('/api/role-instances', {
      templateName: tplName,
      memberName: 'sess-u',
    });
    if (instRes.status !== 201) return;
    const inst = (await instRes.json()) as { id: string; status: string };
    expect(inst.status).toBe('PENDING');

    const res = await post('/api/sessions/register', { instanceId: inst.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ACTIVE');

    // 清理
    await fetch(`${BASE}/api/role-instances/${inst.id}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  });

  it('POST 不存在的 instanceId → 404', async () => {
    const res = await post('/api/sessions/register', {
      instanceId: 'ghost-instance-id-does-not-exist',
    });
    expect(res.status).toBe(404);
  });
});
