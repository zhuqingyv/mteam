// HTTP 集成测试：/api/primary-agent 系列 4 个接口
// 用 Bun.spawn 起真实 server 子进程，:memory: DB + 随机端口，fetch 打真实 HTTP。
// 覆盖：GET 未配置/已配置、POST /config 首次+幂等、POST /start、POST /stop 未运行 409。
//
// start 用例：TEAM_HUB_CLI_BIN=/usr/bin/true 让 spawn 的 CLI 立即退出，
// 只接受 200 或 400（真实 CLI 环境差异大，不强求 200）。

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-primary-agent-${process.pid}-${PORT}.sock`;
const TRUE_BIN = '/usr/bin/true';
const HAS_TRUE = existsSync(TRUE_BIN);
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'team-hub-pa-home-'));

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/primary-agent`, {
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
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
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

interface PrimaryAgentRowJson {
  id: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  status: 'STOPPED' | 'RUNNING';
}

describe('HTTP /api/primary-agent 全流程', () => {
  it('GET 未配置 → 200 null', async () => {
    const r = await request('/api/primary-agent');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });

  it('POST /config 首次 → 200 带 id/name/cliType', async () => {
    const r = await request('/api/primary-agent/config', {
      method: 'POST',
      body: { name: 'Orchestrator', cliType: 'claude' },
    });
    expect(r.status).toBe(200);
    const body = r.body as PrimaryAgentRowJson;
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Orchestrator');
    expect(body.cliType).toBe('claude');
    expect(body.status).toBe('STOPPED');
  });

  it('GET 已配置 → 200 带数据', async () => {
    const r = await request('/api/primary-agent');
    expect(r.status).toBe(200);
    const body = r.body as PrimaryAgentRowJson;
    expect(body).not.toBeNull();
    expect(body.name).toBe('Orchestrator');
  });

  it('POST /config 再次 → 200 且 id 不变', async () => {
    const before = (await request('/api/primary-agent')).body as PrimaryAgentRowJson;
    const r = await request('/api/primary-agent/config', {
      method: 'POST',
      body: { name: 'Orchestrator-v2', systemPrompt: 'hello' },
    });
    expect(r.status).toBe(200);
    const body = r.body as PrimaryAgentRowJson;
    expect(body.id).toBe(before.id);
    expect(body.name).toBe('Orchestrator-v2');
    expect(body.systemPrompt).toBe('hello');
    expect(body.cliType).toBe('claude');
  });

  it('POST /stop 没在跑 → 409', async () => {
    const r = await request('/api/primary-agent/stop', { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('POST /config 字段错误 → 400', async () => {
    const r = await request('/api/primary-agent/config', {
      method: 'POST',
      body: { name: '', cliType: 'claude' },
    });
    expect(r.status).toBe(400);
  });

  it('POST /start → 200 或 400（取决于 CLI 可用性）', async () => {
    // AgentDriver 用 npx 起 ACP 子进程；测试环境里大概率失败或无响应，
    // 这里只验证接口不崩：200（极少）、400（握手失败/CLI 不可用）或超时皆可。
    try {
      const r = await request('/api/primary-agent/start', { method: 'POST' });
      expect([200, 400]).toContain(r.status);
    } catch (e) {
      expect((e as Error).name).toMatch(/TimeoutError|AbortError/);
    }
  });
});
