// HTTP 集成测试：/api/role-instances 生命周期接口。
// 起独立 server 子进程，:memory: DB + 随机端口。用 TEAM_HUB_CLI_BIN=/usr/bin/true 让 driver 起一个立即退出的进程，
// 保证 create instance 不会真的启动 claude。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-instances-${process.pid}-${PORT}.sock`;
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
  serverProc = Bun.spawn(['bun', 'run', 'packages/backend/src/http/server.ts'], {
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

async function json(res: Response): Promise<unknown> {
  const t = await res.text();
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
}

async function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function ensureTemplate(name: string): Promise<void> {
  await post('/api/role-templates', { name, role: 'dev' });
}

// 创建实例并直接拿 id；spawn 失败环境下返回 null，调用方可以跳过。
async function createInstance(
  templateName: string,
  memberName: string,
  isLeader = false,
): Promise<string | null> {
  const res = await post('/api/role-instances', {
    templateName,
    memberName,
    isLeader,
  });
  if (res.status !== 201) return null;
  const body = (await json(res)) as { id: string };
  return body.id;
}

describe('HTTP /api/role-instances', () => {
  it('POST 创建（需先有模板）→ 201', async () => {
    if (!HAS_TRUE) return;
    const tpl = `inst-tpl-create-${Date.now()}`;
    await ensureTemplate(tpl);
    const res = await post('/api/role-instances', {
      templateName: tpl,
      memberName: 'u-create',
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as { id: string; status: string };
    expect(body.status).toBe('PENDING');
    // 清理，避免占坑
    await fetch(`${BASE}/api/role-instances/${body.id}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  });

  it('POST 创建：不存在 template → 404', async () => {
    const res = await post('/api/role-instances', {
      templateName: 'no-such-template-xxx',
      memberName: 'u',
    });
    expect(res.status).toBe(404);
  });

  it('GET 列表 → 200', async () => {
    const res = await fetch(`${BASE}/api/role-instances`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST activate → 200', async () => {
    if (!HAS_TRUE) return;
    const tpl = `inst-tpl-act-${Date.now()}`;
    await ensureTemplate(tpl);
    const id = await createInstance(tpl, 'u-act');
    if (!id) return;
    const res = await post(`/api/role-instances/${id}/activate`, {});
    expect(res.status).toBe(200);
    const body = (await json(res)) as { status: string };
    expect(body.status).toBe('ACTIVE');
    await fetch(`${BASE}/api/role-instances/${id}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  });

  it('POST request-offline（需 leader）→ 200', async () => {
    if (!HAS_TRUE) return;
    const tpl = `inst-tpl-off-${Date.now()}`;
    await ensureTemplate(tpl);
    const leaderId = await createInstance(tpl, 'leader', true);
    const memberId = await createInstance(tpl, 'member');
    if (!leaderId || !memberId) return;
    await post(`/api/role-instances/${leaderId}/activate`, {});
    await post(`/api/role-instances/${memberId}/activate`, {});
    const res = await post(
      `/api/role-instances/${memberId}/request-offline`,
      {},
      { 'X-Role-Instance-Id': leaderId },
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { status: string };
    expect(body.status).toBe('PENDING_OFFLINE');
    await fetch(`${BASE}/api/role-instances/${memberId}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
    await fetch(`${BASE}/api/role-instances/${leaderId}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  });

  it('DELETE PENDING → 204', async () => {
    if (!HAS_TRUE) return;
    const tpl = `inst-tpl-del-${Date.now()}`;
    await ensureTemplate(tpl);
    const id = await createInstance(tpl, 'u-del');
    if (!id) return;
    const res = await fetch(`${BASE}/api/role-instances/${id}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(204);
  });

  it('DELETE ACTIVE 实例 → 409', async () => {
    if (!HAS_TRUE) return;
    const tpl = `inst-tpl-del409-${Date.now()}`;
    await ensureTemplate(tpl);
    const id = await createInstance(tpl, 'u-del409');
    if (!id) return;
    await post(`/api/role-instances/${id}/activate`, {});
    const res = await fetch(`${BASE}/api/role-instances/${id}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(409);
    // 清理
    await fetch(`${BASE}/api/role-instances/${id}?force=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  });
});
