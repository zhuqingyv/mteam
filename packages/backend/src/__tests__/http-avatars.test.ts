// HTTP 集成测试：/api/panel/avatars 与 /api/avatars。
// 起真实 server 子进程（:memory: DB），fetch 打真实 HTTP。
// server 启动时 ensureBuiltinAvatars() 会插入 avatar-01 ~ avatar-20。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/test-http-avatars-${process.pid}-${PORT}.sock`;
const PID_FILE = `/tmp/test-http-avatars-${process.pid}-${PORT}.pid`;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/panel/avatars`, {
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
      TEAM_HUB_BACKEND_PID: PID_FILE,
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

interface AvatarDto {
  id: string;
  filename: string;
  builtin: boolean;
}

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

describe('HTTP /api/panel/avatars', () => {
  it('GET 列表 → 200 + avatars 数组包含内置头像', async () => {
    const r = await request('/api/panel/avatars');
    expect(r.status).toBe(200);
    const body = r.body as { avatars: AvatarDto[] };
    expect(Array.isArray(body.avatars)).toBe(true);
    expect(body.avatars.length).toBeGreaterThanOrEqual(20);
    const one = body.avatars.find((a) => a.id === 'avatar-01');
    expect(one).toBeDefined();
    expect(one!.builtin).toBe(true);
    expect(one!.filename).toBe('avatar-01.png');
  });

  it('POST 添加自定义 → 201 + builtin=false', async () => {
    const id = `avatar-custom-${Date.now()}`;
    const r = await request('/api/panel/avatars', {
      method: 'POST',
      body: { id, filename: 'my-avatar.png' },
    });
    expect(r.status).toBe(201);
    const body = r.body as AvatarDto;
    expect(body.id).toBe(id);
    expect(body.filename).toBe('my-avatar.png');
    expect(body.builtin).toBe(false);
  });

  it('DELETE 内置 → 200 (hidden)；再 GET 列表里没了；restore 后回来', async () => {
    const del = await request('/api/panel/avatars/avatar-02', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((del.body as { ok: boolean }).ok).toBe(true);

    const after = await request('/api/panel/avatars');
    const list = (after.body as { avatars: AvatarDto[] }).avatars;
    expect(list.find((a) => a.id === 'avatar-02')).toBeUndefined();

    const restore = await request('/api/panel/avatars/restore', { method: 'POST' });
    expect(restore.status).toBe(200);
    expect((restore.body as { restored: number }).restored).toBeGreaterThanOrEqual(1);

    const back = await request('/api/panel/avatars');
    const list2 = (back.body as { avatars: AvatarDto[] }).avatars;
    expect(list2.find((a) => a.id === 'avatar-02')).toBeDefined();
  });

  it('DELETE 不存在 → 404', async () => {
    const r = await request('/api/panel/avatars/ghost-does-not-exist', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('GET /random → 200 + avatar 对象', async () => {
    const r = await request('/api/panel/avatars/random');
    expect(r.status).toBe(200);
    const body = r.body as { avatar: AvatarDto | null };
    expect(body.avatar).not.toBeNull();
    expect(typeof body.avatar!.id).toBe('string');
    expect(typeof body.avatar!.filename).toBe('string');
    expect(typeof body.avatar!.builtin).toBe('boolean');
  });

  it('DELETE 自定义 → 200 (真删)', async () => {
    const id = `avatar-del-${Date.now()}`;
    await request('/api/panel/avatars', {
      method: 'POST',
      body: { id, filename: 'tmp.png' },
    });
    const del = await request(`/api/panel/avatars/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const again = await request(`/api/panel/avatars/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

});
