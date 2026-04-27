// HTTP 集成测试：GET /api/mcp-tools/search
// 起真实 server 子进程 + :memory: DB + 随机端口，验证 searchTools 回调接口。
// 关键矩阵：
// - 缺参 → 400
// - 不存在的 instance → 404
// - 模板带 mteam search 配置 → 能按关键词命中
// - surface='*' → 次屏为空 → 命中 0
// - 模板无 searchable 项 → 命中 0

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-mcp-tools-${process.pid}-${PORT}.sock`;
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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function createTemplate(
  name: string,
  availableMcps: unknown[],
): Promise<void> {
  const res = await post('/api/role-templates', {
    name,
    role: 'dev',
    availableMcps,
  });
  if (res.status !== 201) {
    throw new Error(`template create failed: ${res.status}`);
  }
}

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
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function searchHits(instanceId: string, q: string): Promise<Response> {
  const url =
    `${BASE}/api/mcp-tools/search?instanceId=${encodeURIComponent(instanceId)}` +
    `&q=${encodeURIComponent(q)}`;
  return fetch(url, { signal: AbortSignal.timeout(3000) });
}

describe('GET /api/mcp-tools/search', () => {
  it('缺 instanceId → 400', async () => {
    const res = await fetch(`${BASE}/api/mcp-tools/search?q=send`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(400);
  });

  it('缺 q → 400', async () => {
    const res = await fetch(
      `${BASE}/api/mcp-tools/search?instanceId=nope`,
      { signal: AbortSignal.timeout(3000) },
    );
    expect(res.status).toBe(400);
  });

  it('不存在的 instance → 404', async () => {
    const res = await searchHits('ghost-xxx', 'send');
    expect(res.status).toBe(404);
  });

  it('模板 mteam surface=[activate] search=* → 能搜到 send_msg', async () => {
    if (!HAS_TRUE) return;
    const tpl = `tpl-srch-${Date.now()}`;
    await createTemplate(tpl, [
      { name: 'mteam', surface: ['activate'], search: '*' },
    ]);
    const id = await createInstance(tpl, 'u-srch');
    if (!id) return;

    try {
      const res = await searchHits(id, 'send');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hits: Array<{ mcpServer: string; toolName: string; description: string }>;
      };
      const names = body.hits.map((h) => h.toolName);
      expect(names).toContain('send_msg');
      // surface 里声明的 activate 不应出现
      expect(names).not.toContain('activate');
    } finally {
      await fetch(`${BASE}/api/role-instances/${id}?force=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      });
    }
  });

  it('surface=* → 命中 0（全部视为首屏，次屏为空）', async () => {
    if (!HAS_TRUE) return;
    const tpl = `tpl-srch-all-${Date.now()}`;
    await createTemplate(tpl, [
      { name: 'mteam', surface: '*', search: '*' },
    ]);
    const id = await createInstance(tpl, 'u-srch-all');
    if (!id) return;

    try {
      const res = await searchHits(id, 'send');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hits: unknown[] };
      expect(body.hits.length).toBe(0);
    } finally {
      await fetch(`${BASE}/api/role-instances/${id}?force=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      });
    }
  });

  it('request_offline 是 leaderOnly：非 leader 实例搜不到', async () => {
    if (!HAS_TRUE) return;
    const tpl = `tpl-srch-ro-${Date.now()}`;
    await createTemplate(tpl, [
      { name: 'mteam', surface: [], search: '*' },
    ]);
    const memberId = await createInstance(tpl, 'u-member', false);
    if (!memberId) return;

    try {
      const res = await searchHits(memberId, 'request_offline');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hits: Array<{ toolName: string }>;
      };
      expect(body.hits.map((h) => h.toolName)).not.toContain('request_offline');
    } finally {
      await fetch(`${BASE}/api/role-instances/${memberId}?force=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      });
    }
  });

  it('request_offline 是 leaderOnly：leader 实例能搜到', async () => {
    if (!HAS_TRUE) return;
    const tpl = `tpl-srch-ro-ld-${Date.now()}`;
    await createTemplate(tpl, [
      { name: 'mteam', surface: [], search: '*' },
    ]);
    const leaderId = await createInstance(tpl, 'u-leader', true);
    if (!leaderId) return;

    try {
      const res = await searchHits(leaderId, 'request_offline');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hits: Array<{ toolName: string }>;
      };
      expect(body.hits.map((h) => h.toolName)).toContain('request_offline');
    } finally {
      await fetch(`${BASE}/api/role-instances/${leaderId}?force=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      });
    }
  });

  it('search=[check_inbox] → 只能搜到 check_inbox', async () => {
    if (!HAS_TRUE) return;
    const tpl = `tpl-srch-lim-${Date.now()}`;
    await createTemplate(tpl, [
      { name: 'mteam', surface: [], search: ['check_inbox'] },
    ]);
    const id = await createInstance(tpl, 'u-srch-lim');
    if (!id) return;

    try {
      const sendRes = await searchHits(id, 'send_msg');
      expect(sendRes.status).toBe(200);
      const sendBody = (await sendRes.json()) as { hits: unknown[] };
      expect(sendBody.hits.length).toBe(0);

      const inboxRes = await searchHits(id, 'inbox');
      expect(inboxRes.status).toBe(200);
      const inboxBody = (await inboxRes.json()) as {
        hits: Array<{ toolName: string }>;
      };
      expect(inboxBody.hits.map((h) => h.toolName)).toEqual(['check_inbox']);
    } finally {
      await fetch(`${BASE}/api/role-instances/${id}?force=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      });
    }
  });
});
