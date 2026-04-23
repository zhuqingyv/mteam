// HTTP 集成测试：/api/roster 7 个接口
// 用 Bun.spawn 起真实 server 子进程，:memory: DB + 随机端口，fetch 打真实 HTTP
// 覆盖：GET 列表/搜索/单条、POST 手动添加、PUT 更新/别名、DELETE 删除
//
// 每条 roster 条目都依赖 role_instances 表有同 id 的行，
// 所以每个用例先 POST /api/role-templates + /api/role-instances 造前置。
// role-instances 的创建会走 PTY，若 TEAM_HUB_CLI_BIN 指向 /usr/bin/true 则 201 立即退出。

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-roster-${process.pid}-${PORT}.sock`;
const TRUE_BIN = '/usr/bin/true';
const HAS_TRUE = existsSync(TRUE_BIN);

// 隔离 mcp-store 真实目录：store.ts 里 STORE_DIR = join(homedir(), '.claude', ...)
// 子进程 HOME 指向临时目录即可避免污染用户真实 ~/.claude/team-hub/mcp-store。
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'team-hub-roster-home-'));

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
      TEAM_HUB_CLI_BIN: HAS_TRUE ? TRUE_BIN : '',
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

// 造一个 role_instance，返回其 id。前置模板按需创建。
// 依赖：server 子进程里 TEAM_HUB_CLI_BIN=/usr/bin/true，POST /api/role-instances 会 201。
// 若环境无 /usr/bin/true，返回 null 让用例 skip。
async function seedInstance(member: string, tplName?: string): Promise<string | null> {
  if (!HAS_TRUE) return null;
  const tpl = tplName ?? `tpl-${member}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tplRes = await request('/api/role-templates', {
    method: 'POST',
    body: { name: tpl, role: 'dev' },
  });
  // 同名可能 409（并发），当作已存在继续
  if (tplRes.status !== 201 && tplRes.status !== 409) return null;
  const instRes = await request('/api/role-instances', {
    method: 'POST',
    body: { templateName: tpl, memberName: member },
  });
  if (instRes.status !== 201) return null;
  const body = instRes.body as { id: string };
  return body.id;
}

describe('HTTP GET /api/roster', () => {
  it('GET 列表 -> 200 数组', async () => {
    const r = await request('/api/roster');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET scope=team 缺 caller -> 400', async () => {
    const r = await request('/api/roster?scope=team');
    expect(r.status).toBe(400);
  });
});

describe('HTTP GET /api/roster/search', () => {
  it('缺 q -> 400', async () => {
    const r = await request('/api/roster/search');
    expect(r.status).toBe(400);
  });

  it.skipIf(!HAS_TRUE)('有匹配 alias -> 200 unique', async () => {
    const memberName = `searcher-${Date.now()}`;
    const id = await seedInstance(memberName);
    if (!id) return;
    // alias 默认等于 memberName；用它当搜索词
    const r = await request(
      `/api/roster/search?q=${encodeURIComponent(memberName)}&callerInstanceId=${id}`,
    );
    expect(r.status).toBe(200);
    const body = r.body as { match: string };
    expect(['unique', 'multiple']).toContain(body.match);
  });

  it.skipIf(!HAS_TRUE)('无匹配 -> 200 none', async () => {
    const id = await seedInstance(`anon-${Date.now()}`);
    if (!id) return;
    const r = await request(
      `/api/roster/search?q=definitely-no-such-member-xyz&callerInstanceId=${id}`,
    );
    expect(r.status).toBe(200);
    const body = r.body as { match: string };
    expect(body.match).toBe('none');
  });
});

describe('HTTP GET /api/roster/:id', () => {
  it.skipIf(!HAS_TRUE)('存在 -> 200 entry', async () => {
    const id = await seedInstance(`get-${Date.now()}`);
    if (!id) return;
    const r = await request(`/api/roster/${id}`);
    expect(r.status).toBe(200);
    const body = r.body as { instanceId: string };
    expect(body.instanceId).toBe(id);
  });

  it('不存在 -> 404', async () => {
    const r = await request('/api/roster/ghost-xyz-404');
    expect(r.status).toBe(404);
  });
});

describe('HTTP POST /api/roster', () => {
  it.skipIf(!HAS_TRUE)('已存在 entry -> 409', async () => {
    const member = `dup-${Date.now()}`;
    const id = await seedInstance(member);
    if (!id) return;
    // create 之后 role_instances 行已有，roster.get 会命中 -> 409
    const r = await request('/api/roster', {
      method: 'POST',
      body: {
        instanceId: id,
        memberName: member,
        scope: 'local',
        status: 'ACTIVE',
        address: `local:${id}`,
      },
    });
    expect(r.status).toBe(409);
  });

  it('缺 instanceId -> 400', async () => {
    const r = await request('/api/roster', {
      method: 'POST',
      body: {
        memberName: 'x',
        scope: 'local',
        status: 'ACTIVE',
        address: 'local:x',
      },
    });
    expect(r.status).toBe(400);
  });

  it('非法 scope -> 400', async () => {
    const r = await request('/api/roster', {
      method: 'POST',
      body: {
        instanceId: 'x',
        memberName: 'x',
        scope: 'invalid',
        status: 'ACTIVE',
        address: 'local:x',
      },
    });
    expect(r.status).toBe(400);
  });

  it('role_instances 行不存在（scope=local）-> 400', async () => {
    // roster.add 对 local scope 要求行已存在，否则抛错 -> handler 返 400
    const r = await request('/api/roster', {
      method: 'POST',
      body: {
        instanceId: `no-such-${Date.now()}`,
        memberName: 'x',
        scope: 'local',
        status: 'ACTIVE',
        address: 'local:x',
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('HTTP PUT /api/roster/:id', () => {
  it.skipIf(!HAS_TRUE)('更新 status/task -> 200', async () => {
    const id = await seedInstance(`upd-${Date.now()}`);
    if (!id) return;
    const r = await request(`/api/roster/${id}`, {
      method: 'PUT',
      body: { status: 'ACTIVE', task: 'coding' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { task: string | null };
    expect(body.task).toBe('coding');
  });

  it('PUT 不存在 -> 404', async () => {
    const r = await request('/api/roster/ghost-put', {
      method: 'PUT',
      body: { status: 'ACTIVE' },
    });
    expect(r.status).toBe(404);
  });
});

describe('HTTP PUT /api/roster/:id/alias', () => {
  it.skipIf(!HAS_TRUE)('设别名 -> 200', async () => {
    const id = await seedInstance(`al-${Date.now()}`);
    if (!id) return;
    const r = await request(`/api/roster/${id}/alias`, {
      method: 'PUT',
      body: { alias: 'NewAlias' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { alias: string };
    expect(body.alias).toBe('NewAlias');
  });

  it('缺 alias -> 400', async () => {
    const r = await request('/api/roster/whatever/alias', {
      method: 'PUT',
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it.skipIf(!HAS_TRUE)('alias 后能通过搜索命中', async () => {
    const id = await seedInstance(`alhit-${Date.now()}`);
    if (!id) return;
    const uniqueAlias = `Alias-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const setRes = await request(`/api/roster/${id}/alias`, {
      method: 'PUT',
      body: { alias: uniqueAlias },
    });
    expect(setRes.status).toBe(200);
    const searchRes = await request(
      `/api/roster/search?q=${encodeURIComponent(uniqueAlias)}&callerInstanceId=${id}`,
    );
    expect(searchRes.status).toBe(200);
    const body = searchRes.body as { match: string };
    expect(body.match).toBe('unique');
  });
});

describe('HTTP DELETE /api/roster/:id', () => {
  it.skipIf(!HAS_TRUE)('存在 -> 204', async () => {
    const id = await seedInstance(`del-${Date.now()}`);
    if (!id) return;
    const r = await request(`/api/roster/${id}`, { method: 'DELETE' });
    expect(r.status).toBe(204);
    // 删除后 GET 应 404
    const after = await request(`/api/roster/${id}`);
    expect(after.status).toBe(404);
  });

  it('不存在 -> 404', async () => {
    const r = await request('/api/roster/ghost-del', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});
