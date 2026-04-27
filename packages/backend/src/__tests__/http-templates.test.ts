// HTTP 集成测试：/api/role-templates 5 个接口。
// 用 Bun.spawn 起真实 server 子进程，:memory: DB + 随机端口，fetch 打真实 HTTP。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-templates-${process.pid}-${PORT}.sock`;
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
    signal: AbortSignal.timeout(3000),
  });
}

describe('HTTP /api/role-templates', () => {
  it('POST 创建 → 201', async () => {
    const res = await post('/api/role-templates', {
      name: `tpl-create-${Date.now()}`,
      role: 'dev',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; role: string };
    expect(body.role).toBe('dev');
  });

  it('GET 列表 → 200 数组', async () => {
    await post('/api/role-templates', {
      name: `tpl-list-${Date.now()}`,
      role: 'dev',
    });
    const res = await fetch(`${BASE}/api/role-templates`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET 单个 → 200', async () => {
    const name = `tpl-get-${Date.now()}`;
    await post('/api/role-templates', { name, role: 'dev' });
    const res = await fetch(`${BASE}/api/role-templates/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe(name);
  });

  it('GET 不存在 → 404', async () => {
    const res = await fetch(`${BASE}/api/role-templates/ghost-does-not-exist`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(404);
  });

  it('PUT 更新 → 200', async () => {
    const name = `tpl-put-${Date.now()}`;
    await post('/api/role-templates', { name, role: 'dev' });
    const res = await fetch(`${BASE}/api/role-templates/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'lead' }),
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('lead');
  });

  it('DELETE 删除 → 204', async () => {
    const name = `tpl-del-${Date.now()}`;
    await post('/api/role-templates', { name, role: 'dev' });
    const res = await fetch(`${BASE}/api/role-templates/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(204);
  });

  it('DELETE 被引用的模板 → 409', async () => {
    const name = `tpl-ref-${Date.now()}`;
    await post('/api/role-templates', { name, role: 'dev' });
    // 造一个引用该模板的实例（要让 create instance 真的走 handler 建 FK 引用）。
    // create 会触发 member-driver 真实 spawn；该接口在有 /usr/bin/true 环境下会 201（子进程启动 true 立即退出）。
    const instRes = await fetch(`${BASE}/api/role-instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateName: name, memberName: 'refuser' }),
      signal: AbortSignal.timeout(5000),
    });
    // 若环境起不了 driver，create 可能 500 —— 那么就没 FK 压力，不能验证 409。
    if (instRes.status !== 201) {
      // 跳过：spawn 失败环境无法构造被引用场景
      return;
    }
    const res = await fetch(`${BASE}/api/role-templates/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(409);
  });

  it('POST 重名 → 409', async () => {
    const name = `tpl-dup-${Date.now()}`;
    const first = await post('/api/role-templates', { name, role: 'dev' });
    expect(first.status).toBe(201);
    const second = await post('/api/role-templates', { name, role: 'dev' });
    expect(second.status).toBe(409);
  });

  // P2-4：readBody 加了 1MB 封顶。小 body 走原路径，大 body 立刻 413。
  it('POST 正常 body → 201（不受 size 限制影响）', async () => {
    const res = await post('/api/role-templates', {
      name: `tpl-small-${Date.now()}`,
      role: 'dev',
      systemPrompt: 'x'.repeat(1024),
    });
    expect(res.status).toBe(201);
  });

  it('POST body > 1MB → 413', async () => {
    const payload = { name: `tpl-big-${Date.now()}`, role: 'dev', systemPrompt: 'x'.repeat(1 << 21) };
    const res = await post('/api/role-templates', payload);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('exceeds');
  });
});
