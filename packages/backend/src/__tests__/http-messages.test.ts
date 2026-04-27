// HTTP 集成测试：W2-I · /api/messages + /api/role-instances/:id/inbox + /api/teams/:teamId/messages
// 起真实 http.Server（createServer，不跑 CommServer）+ :memory: DB。
// POST /send 用 fake CommRouter 注入 messages-context；GET 端点直接走 createMessageStore() + 真 DB。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../http/server.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { closeDb, getDb } from '../db/connection.js';
import { createMessageStore } from '../comm/message-store.js';
import { setMessagesContext, resetMessagesContext } from '../http/messages-context.js';
import type { MessageEnvelope } from '../comm/envelope.js';
import type { DispatchOutcome } from '../comm/router.js';

let server: http.Server;
let base: string;

interface FakeRouter {
  dispatch: (env: MessageEnvelope) => Promise<DispatchOutcome>;
  setSystemHandler: () => void;
  replay: () => number;
}

function makeFakeRouter(opts: { outcome?: DispatchOutcome; fail?: boolean; onDispatch?: (env: MessageEnvelope) => void } = {}): FakeRouter {
  return {
    async dispatch(env: MessageEnvelope): Promise<DispatchOutcome> {
      opts.onDispatch?.(env);
      if (opts.fail) throw new Error('boom');
      // fake 的 router 也要落库，因为真 router 会同步落库；我们模拟该契约。
      createMessageStore().insert(env);
      return opts.outcome ?? { route: 'local-online', address: env.to.address };
    },
    setSystemHandler(): void { /* noop */ },
    replay(): number { return 0; },
  };
}

async function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined && !('content-type' in headers) && !('Content-Type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)),
    signal: AbortSignal.timeout(3000),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function seedInstance(params: { member: string; alias?: string; isLeader?: boolean; tpl?: string }): string {
  const tpl = params.tpl ?? 'tpl';
  if (!RoleTemplate.findByName(tpl)) RoleTemplate.create({ name: tpl, role: 'w' });
  const inst = RoleInstance.create({
    templateName: tpl,
    memberName: params.member,
    isLeader: params.isLeader,
  });
  if (params.alias) {
    getDb().prepare(`UPDATE role_instances SET alias = ? WHERE id = ?`).run(params.alias, inst.id);
  }
  return inst.id;
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  resetMessagesContext();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  closeDb();
  getDb();
  resetMessagesContext();
});

describe('POST /api/messages/send', () => {
  it('最小 body (to.address + content) → 200 + lookup 补全 + strong-inject user', async () => {
    const leaderId = seedInstance({ member: 'leader', alias: '总控', isLeader: true });
    let captured: MessageEnvelope | null = null;
    setMessagesContext({ router: makeFakeRouter({ onDispatch: (e) => { captured = e; } }) as never });

    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: `local:${leaderId}` }, content: '开工' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { messageId: string; route: string };
    expect(body.messageId).toMatch(/^msg_/);
    expect(body.route).toBe('local-online');

    expect(captured).not.toBeNull();
    const env = captured as unknown as MessageEnvelope;
    expect(env.from.kind).toBe('user');
    expect(env.from.address).toBe('user:local');
    expect(env.to.kind).toBe('agent');
    expect(env.to.address).toBe(`local:${leaderId}`);
    expect(env.to.displayName).toBe('总控');
    expect(env.to.instanceId).toBe(leaderId);
    expect(env.to.memberName).toBe('leader');
    expect(env.summary).toBe('给你发了一条消息');
    expect(env.content).toBe('开工');

    const row = getDb()
      .prepare(`SELECT from_kind, to_instance_id, to_display FROM messages WHERE envelope_uuid = ?`)
      .get(env.id) as { from_kind: string; to_instance_id: string; to_display: string };
    expect(row.from_kind).toBe('user');
    expect(row.to_instance_id).toBe(leaderId);
    expect(row.to_display).toBe('总控');
  });

  it('W2-C 不传 from → envelope.from.displayName === User（默认，向后兼容）', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    let captured: MessageEnvelope | null = null;
    setMessagesContext({ router: makeFakeRouter({ onDispatch: (e) => { captured = e; } }) as never });

    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(200);
    const env = captured as unknown as MessageEnvelope;
    expect(env.from.kind).toBe('user');
    expect(env.from.address).toBe('user:local');
    expect(env.from.displayName).toBe('User');
  });

  it('W2-C from.displayName override → envelope.from.displayName 覆盖成功', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    let captured: MessageEnvelope | null = null;
    setMessagesContext({ router: makeFakeRouter({ onDispatch: (e) => { captured = e; } }) as never });

    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { displayName: '测试脚本A' }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(200);
    const env = captured as unknown as MessageEnvelope;
    expect(env.from.kind).toBe('user');
    expect(env.from.address).toBe('user:local');
    expect(env.from.displayName).toBe('测试脚本A');
  });

  it('W2-C from.displayName 前后空格 → trim 后成功', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    let captured: MessageEnvelope | null = null;
    setMessagesContext({ router: makeFakeRouter({ onDispatch: (e) => { captured = e; } }) as never });

    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { displayName: '  空格名  ' }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(200);
    const env = captured as unknown as MessageEnvelope;
    expect(env.from.displayName).toBe('空格名');
  });

  it('W2-C from.displayName 空串 → 400', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { displayName: '   ' }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(400);
  });

  it('W2-C from.displayName 超 64 字符 → 400', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { displayName: 'a'.repeat(65) }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(400);
  });

  it('W2-C from.displayName 非 string → 400', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { displayName: 123 }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(400);
  });

  it('W2-C from.kind=agent → 400（本期禁 agent）', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { kind: 'agent', address: 'local:x' }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(400);
  });

  it('W2-C from.kind=system → 400（HTTP 永禁 system）', async () => {
    const leaderId = seedInstance({ member: 'leader' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { from: { kind: 'system' }, to: { kind: 'agent', address: `local:${leaderId}` }, content: 'hi' },
    });
    expect(r.status).toBe(400);
  });

  it('address 对应实例不存在 → 404', async () => {
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: 'local:ghostid' }, content: 'x' },
    });
    expect(r.status).toBe(404);
  });

  it('Content-Type 不是 JSON → 415', async () => {
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: 'plain text',
      headers: { 'content-type': 'text/plain' },
    });
    expect(r.status).toBe(415);
  });

  it('to.kind=user → 400（只允许 agent）', async () => {
    const id = seedInstance({ member: 'm' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'user', address: `local:${id}` }, content: 'x' },
    });
    expect(r.status).toBe(400);
  });

  it('缺 content → 400', async () => {
    const id = seedInstance({ member: 'm' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: `local:${id}` } },
    });
    expect(r.status).toBe(400);
  });

  it('router 未注入 → 503', async () => {
    const id = seedInstance({ member: 'm' });
    resetMessagesContext();
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: `local:${id}` }, content: 'x' },
    });
    expect(r.status).toBe(503);
  });

  it('body.to.instanceId 与 address 不一致 → 400', async () => {
    const id = seedInstance({ member: 'm' });
    seedInstance({ member: 'n' });
    setMessagesContext({ router: makeFakeRouter() as never });
    const r = await req('/api/messages/send', {
      method: 'POST',
      body: { to: { kind: 'agent', address: `local:${id}`, instanceId: 'otherid' }, content: 'x' },
    });
    expect(r.status).toBe(400);
  });
});

function insertEnvelope(e: Partial<MessageEnvelope> & { id: string; to: MessageEnvelope['to']; from: MessageEnvelope['from']; kind: MessageEnvelope['kind']; summary: string; ts: string }): void {
  createMessageStore().insert({
    id: e.id,
    from: e.from,
    to: e.to,
    teamId: e.teamId ?? null,
    kind: e.kind,
    summary: e.summary,
    content: e.content ?? 'full',
    replyTo: e.replyTo ?? null,
    ts: e.ts,
    readAt: null,
    attachments: e.attachments,
  });
}

function fromUser(): MessageEnvelope['from'] {
  return { kind: 'user', address: 'user:local', displayName: 'User', instanceId: null, memberName: null };
}

function toAgent(id: string, display = 'Bob'): MessageEnvelope['to'] {
  return { kind: 'agent', address: `local:${id}`, displayName: display, instanceId: id, memberName: 'm' };
}

describe('GET /api/messages/:id', () => {
  it('命中 → 200 返回 envelope', async () => {
    const id = seedInstance({ member: 'bob' });
    insertEnvelope({ id: 'msg_abc', from: fromUser(), to: toAgent(id), kind: 'chat', summary: 'hi', ts: '2026-04-25T10:00:00.000Z' });
    const r = await req('/api/messages/msg_abc');
    expect(r.status).toBe(200);
    const body = r.body as { envelope: MessageEnvelope };
    expect(body.envelope.id).toBe('msg_abc');
    expect(body.envelope.content).toBe('full');
    expect(body.envelope.readAt).toBeNull();
  });

  it('不存在 → 404', async () => {
    const r = await req('/api/messages/msg_ghost');
    expect(r.status).toBe(404);
  });

  it('?markRead=true → read_at 写入', async () => {
    const id = seedInstance({ member: 'bob' });
    insertEnvelope({ id: 'msg_mr', from: fromUser(), to: toAgent(id), kind: 'chat', summary: 'hi', ts: '2026-04-25T10:00:00.000Z' });
    const r = await req('/api/messages/msg_mr?markRead=true');
    expect(r.status).toBe(200);
    const body = r.body as { envelope: MessageEnvelope };
    expect(body.envelope.readAt).not.toBeNull();
    const row = getDb().prepare(`SELECT read_at FROM messages WHERE envelope_uuid = ?`).get('msg_mr') as { read_at: string | null };
    expect(row.read_at).not.toBeNull();
  });

  it('默认不带 markRead → read_at 保持 null', async () => {
    const id = seedInstance({ member: 'bob' });
    insertEnvelope({ id: 'msg_no', from: fromUser(), to: toAgent(id), kind: 'chat', summary: 'hi', ts: '2026-04-25T10:00:00.000Z' });
    await req('/api/messages/msg_no');
    const row = getDb().prepare(`SELECT read_at FROM messages WHERE envelope_uuid = ?`).get('msg_no') as { read_at: string | null };
    expect(row.read_at).toBeNull();
  });
});

describe('GET /api/role-instances/:instanceId/inbox', () => {
  it('peek=true → 返回摘要，read_at 不改', async () => {
    const id = seedInstance({ member: 'bob' });
    for (let i = 0; i < 3; i++) {
      insertEnvelope({ id: `msg_p${i}`, from: fromUser(), to: toAgent(id), kind: 'chat', summary: `hi${i}`, ts: `2026-04-25T10:00:0${i}.000Z` });
    }
    const r = await req(`/api/role-instances/${id}/inbox?peek=true`);
    expect(r.status).toBe(200);
    const body = r.body as { messages: Array<{ id: string; readAt: string | null }>; total: number };
    expect(body.total).toBe(3);
    expect(body.messages.length).toBe(3);
    for (const m of body.messages) expect(m.readAt).toBeNull();
    const rows = getDb().prepare(`SELECT read_at FROM messages WHERE to_instance_id = ?`).all(id) as Array<{ read_at: string | null }>;
    for (const r2 of rows) expect(r2.read_at).toBeNull();
  });

  it('peek=false → 标已读', async () => {
    const id = seedInstance({ member: 'bob' });
    insertEnvelope({ id: 'msg_pf', from: fromUser(), to: toAgent(id), kind: 'chat', summary: 'hi', ts: '2026-04-25T10:00:00.000Z' });
    const r = await req(`/api/role-instances/${id}/inbox?peek=false`);
    expect(r.status).toBe(200);
    const row = getDb().prepare(`SELECT read_at FROM messages WHERE envelope_uuid = ?`).get('msg_pf') as { read_at: string | null };
    expect(row.read_at).not.toBeNull();
  });

  it('摘要不含 content 字段', async () => {
    const id = seedInstance({ member: 'bob' });
    insertEnvelope({ id: 'msg_s0', from: fromUser(), to: toAgent(id), kind: 'chat', summary: 'hi', ts: '2026-04-25T10:00:00.000Z' });
    const r = await req(`/api/role-instances/${id}/inbox`);
    const body = r.body as { messages: Array<Record<string, unknown>> };
    expect(body.messages[0]?.content).toBeUndefined();
  });

  it('实例不存在 → 404', async () => {
    const r = await req('/api/role-instances/ghost/inbox');
    expect(r.status).toBe(404);
  });
});

describe('GET /api/teams/:teamId/messages', () => {
  it('按 before 游标分页', async () => {
    const id = seedInstance({ member: 'bob' });
    const leaderId = seedInstance({ member: 'leader_t', isLeader: true });
    const TEAM = 'team_a';
    getDb()
      .prepare(`INSERT INTO teams (id, name, leader_instance_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(TEAM, 'T', leaderId, '2026-04-25T09:00:00.000Z');
    // 插 5 条，ts/顺序递增
    for (let i = 0; i < 5; i++) {
      insertEnvelope({
        id: `msg_t${i}`,
        from: fromUser(),
        to: toAgent(id),
        teamId: TEAM,
        kind: 'chat',
        summary: `s${i}`,
        ts: `2026-04-25T10:00:0${i}.000Z`,
      });
    }
    const page1 = await req(`/api/teams/${TEAM}/messages?limit=2`);
    expect(page1.status).toBe(200);
    const p1 = page1.body as { items: Array<{ id: string }>; nextBefore: string | null; hasMore: boolean };
    expect(p1.hasMore).toBe(true);
    expect(p1.items.length).toBe(2);
    expect(p1.nextBefore).toBeTruthy();

    const page2 = await req(`/api/teams/${TEAM}/messages?limit=2&before=${p1.nextBefore}`);
    const p2 = page2.body as { items: Array<{ id: string }>; hasMore: boolean };
    expect(p2.items.length).toBe(2);
    expect(p2.hasMore).toBe(true);

    const page3 = await req(`/api/teams/${TEAM}/messages?limit=2&before=${(page2.body as { nextBefore: string }).nextBefore}`);
    const p3 = page3.body as { items: Array<{ id: string }>; hasMore: boolean };
    expect(p3.items.length).toBe(1);
    expect(p3.hasMore).toBe(false);
  });

  it('空 team → 200 空列表', async () => {
    const r = await req('/api/teams/ghost_team/messages');
    expect(r.status).toBe(200);
    const body = r.body as { items: unknown[]; hasMore: boolean };
    expect(body.items.length).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});
