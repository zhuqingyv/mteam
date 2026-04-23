// HTTP 集成测试：/api/mcp-store
// 用 Bun.spawn 起真实 server 子进程，:memory: DB + 随机端口，fetch 打真实 HTTP
// 覆盖：GET 列表（含 builtin mteam）、POST install、DELETE、DELETE builtin 403
//
// mcp-store 持久化在 ~/.claude/team-hub/mcp-store/，为避免污染用户真实目录，
// 测试通过 HOME=<tmpdir> 重定向子进程里的 os.homedir()。

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-mcp-store-${process.pid}-${PORT}.sock`;

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'team-hub-mcp-store-home-'));

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/mcp-store`, {
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
      HOME: FAKE_HOME,
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

async function request(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(3000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

interface McpConfig {
  name: string;
  builtin: boolean;
  command: string;
  displayName: string;
  description: string;
  args: string[];
  env: Record<string, string>;
  transport: 'stdio' | 'sse';
}

describe('HTTP GET /api/mcp-store', () => {
  it('200 列表含 builtin mteam', async () => {
    const r = await request('/api/mcp-store');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const list = r.body as McpConfig[];
    const mteam = list.find((c) => c.name === 'mteam');
    expect(mteam).toBeDefined();
    expect(mteam?.builtin).toBe(true);
  });
});

describe('HTTP POST /api/mcp-store/install', () => {
  it('合法 body -> 201', async () => {
    const name = `filesystem-${Date.now()}`;
    const r = await request('/api/mcp-store/install', {
      method: 'POST',
      body: {
        name,
        displayName: 'Filesystem',
        description: 'fs mcp',
        command: 'npx',
        args: ['-y', '@mcp/filesystem'],
        transport: 'stdio',
      },
    });
    expect(r.status).toBe(201);
    const body = r.body as McpConfig;
    expect(body.name).toBe(name);
    expect(body.builtin).toBe(false);
    expect(body.command).toBe('npx');
  });

  it('缺 name -> 400', async () => {
    const r = await request('/api/mcp-store/install', {
      method: 'POST',
      body: { command: 'x' },
    });
    expect(r.status).toBe(400);
  });

  it('缺 command -> 400', async () => {
    const r = await request('/api/mcp-store/install', {
      method: 'POST',
      body: { name: `no-cmd-${Date.now()}` },
    });
    expect(r.status).toBe(400);
  });

  it('builtin=true -> 400（不允许外部注入 builtin）', async () => {
    const r = await request('/api/mcp-store/install', {
      method: 'POST',
      body: {
        name: `fake-builtin-${Date.now()}`,
        command: 'x',
        builtin: true,
      },
    });
    expect(r.status).toBe(400);
  });

  it('非法 args -> 400', async () => {
    const r = await request('/api/mcp-store/install', {
      method: 'POST',
      body: {
        name: `bad-args-${Date.now()}`,
        command: 'x',
        args: 'not-array',
      },
    });
    expect(r.status).toBe(400);
  });

  it('重名 -> 409', async () => {
    const name = `dup-${Date.now()}`;
    const first = await request('/api/mcp-store/install', {
      method: 'POST',
      body: { name, command: 'echo' },
    });
    expect(first.status).toBe(201);
    const second = await request('/api/mcp-store/install', {
      method: 'POST',
      body: { name, command: 'echo' },
    });
    expect(second.status).toBe(409);
  });
});

describe('HTTP DELETE /api/mcp-store/:name', () => {
  it('删除已安装 -> 204', async () => {
    const name = `to-delete-${Date.now()}`;
    const install = await request('/api/mcp-store/install', {
      method: 'POST',
      body: { name, command: 'echo' },
    });
    expect(install.status).toBe(201);
    const del = await request(`/api/mcp-store/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    // 再删应 404
    const again = await request(`/api/mcp-store/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(404);
  });

  it('删除 builtin mteam -> 403', async () => {
    const r = await request('/api/mcp-store/mteam', { method: 'DELETE' });
    expect(r.status).toBe(403);
  });

  it('删除不存在 -> 404', async () => {
    const r = await request('/api/mcp-store/ghost-xyz-404', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});
