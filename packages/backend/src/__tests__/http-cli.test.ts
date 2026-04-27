// HTTP 集成测试：/api/cli 与 /api/cli/refresh
// 起真实 server 子进程（:memory: DB + FAKE_HOME），fetch 打真实 HTTP。
// 覆盖：GET 返回白名单长度数组；POST refresh 成功返回同等结构；POST /api/cli → 404。

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-cli-${process.pid}-${PORT}.sock`;

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'team-hub-cli-home-'));

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/cli`, {
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
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5000),
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

interface CliInfo {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

function assertCliList(list: unknown): asserts list is CliInfo[] {
  expect(Array.isArray(list)).toBe(true);
  const arr = list as CliInfo[];
  expect(arr).toHaveLength(2);
  const names = arr.map((c) => c.name).sort();
  expect(names).toEqual(['claude', 'codex']);
  for (const c of arr) {
    expect(typeof c.available).toBe('boolean');
    if (!c.available) {
      expect(c.path).toBeNull();
      expect(c.version).toBeNull();
    }
  }
}

describe('HTTP GET /api/cli', () => {
  it('200 返回白名单长度的数组，结构符合 CliInfo', async () => {
    const r = await request('/api/cli');
    expect(r.status).toBe(200);
    assertCliList(r.body);
  });
});

describe('HTTP POST /api/cli/refresh', () => {
  it('200 返回重新扫描后的快照', async () => {
    const r = await request('/api/cli/refresh', { method: 'POST' });
    expect(r.status).toBe(200);
    assertCliList(r.body);
  });
});

describe('HTTP /api/cli 方法校验', () => {
  it('POST /api/cli -> 404', async () => {
    const r = await request('/api/cli', { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('GET /api/cli/refresh -> 404', async () => {
    const r = await request('/api/cli/refresh');
    expect(r.status).toBe(404);
  });
});
