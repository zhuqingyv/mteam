// mteam-primary · send_to_agent 单测
// 不 mock：用 :memory: DB + 真实 CommRouter + 真实 InProcessComm + 真实 CommRegistry/MessageStore。
// 只在 lookup 路径装 fake fetch（和 send_msg.test.ts 一致的风格 —— lookup 走 HTTP，是外部边界）。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { runSendToAgent, sendToAgentSchema } from './send_to_agent.js';
import { CommRouter } from '../../comm/router.js';
import { CommRegistry } from '../../comm/registry.js';
import { createMessageStore } from '../../comm/message-store.js';
import { EventBus } from '../../bus/events.js';
import { InProcessComm } from '../../mcp-http/in-process-comm.js';
import { closeDb, getDb } from '../../db/connection.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance } from '../../domain/role-instance.js';
import type { PrimaryMcpEnv } from '../config.js';

const PRIMARY_ID = 'primary_001';
const env: PrimaryMcpEnv = { instanceId: PRIMARY_ID, hubUrl: 'http://hub.test' };

function seedPeer(member: string, isLeader = false): string {
  if (!RoleTemplate.findByName('tpl')) RoleTemplate.create({ name: 'tpl', role: 'worker' });
  return RoleInstance.create({ templateName: 'tpl', memberName: member, isLeader }).id;
}

function seedPrimary(id: string): void {
  // role_instances.id 上有 FK from messages.to_instance_id；peer 走 seedPeer。
  // primary 不是 role_instance，但 router 同步落库时要求 FROM 端 address 合法即可（from 不约束 FK）。
  // 这里只需保证 message can be inserted：to_instance_id FK 指向已 seed 的 peer。
  void id;
}

function makeRouter() {
  const registry = new CommRegistry();
  const store = createMessageStore();
  const eventBus = new EventBus();
  const router = new CommRouter({
    registry,
    messageStore: store,
    eventBus,
    driverDispatcher: async () => 'not-ready', // 走 offline 落库路径，不需要真实 driver
  });
  return { router, registry, store, eventBus };
}

function makeComm(router: CommRouter, selfId = PRIMARY_ID) {
  return new InProcessComm({
    router,
    selfAddress: `local:${selfId}`,
    lookupAgent: (id) => ({ instanceId: id, memberName: id, displayName: id }),
  });
}

beforeEach(() => {
  closeDb();
  getDb();
  seedPrimary(PRIMARY_ID);
});

afterEach(() => {
  closeDb();
});

describe('send_to_agent schema', () => {
  it('to + content are required, additionalProperties=false', () => {
    const s = sendToAgentSchema.inputSchema as { required: string[]; additionalProperties: boolean };
    expect(s.required).toEqual(['to', 'content']);
    expect(s.additionalProperties).toBe(false);
  });

  it('kind enum restricted to chat/task', () => {
    const props = (sendToAgentSchema.inputSchema as { properties: Record<string, { enum?: readonly string[] }> }).properties;
    expect(props.kind.enum).toEqual(['chat', 'task']);
  });

  it('exposes summary + replyTo', () => {
    const props = (sendToAgentSchema.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.summary).toBeDefined();
    expect(props.replyTo).toBeDefined();
  });
});

describe('runSendToAgent · address path', () => {
  it('sends to address target, message lands in peer inbox', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);

    const res = await runSendToAgent(env, comm, {
      to: `local:${peerId}`,
      content: 'hello bob',
    });
    expect(res).toEqual({ delivered: true, to: `local:${peerId}` });

    const inbox = store.listInbox(peerId, { peek: true });
    expect(inbox.total).toBe(1);
    expect(inbox.messages[0].from.address).toBe(`local:${PRIMARY_ID}`);
    expect(inbox.messages[0].kind).toBe('chat');
    const full = store.findById(inbox.messages[0].id);
    expect(full?.content).toBe('hello bob');
  });

  it('to missing → error, nothing stored', async () => {
    seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, { content: 'x' });
    expect((res as { error: string }).error).toContain('to');
    expect(store.listInbox('bob', { peek: true }).total).toBe(0);
  });

  it('content missing → error, nothing stored', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, { to: `local:${peerId}` });
    expect((res as { error: string }).error).toContain('content');
    expect(store.listInbox(peerId, { peek: true }).total).toBe(0);
  });

  it('kind="task" flows through into payload', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    await runSendToAgent(env, comm, { to: `local:${peerId}`, content: 'do it', kind: 'task' });
    const inbox = store.listInbox(peerId, { peek: true });
    expect(inbox.messages[0].kind).toBe('task');
  });

  it('kind="system" rejected', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, {
      to: `local:${peerId}`, content: 'x', kind: 'system',
    });
    expect((res as { error: string }).error).toContain('kind');
    expect(store.listInbox(peerId, { peek: true }).total).toBe(0);
  });

  it('summary defaults when omitted', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    await runSendToAgent(env, comm, { to: `local:${peerId}`, content: 'hi' });
    const inbox = store.listInbox(peerId, { peek: true });
    expect(inbox.messages[0].summary).toBe('给你发了一条消息');
  });

  it('custom summary preserved', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    await runSendToAgent(env, comm, { to: `local:${peerId}`, content: 'hi', summary: 'urgent' });
    const inbox = store.listInbox(peerId, { peek: true });
    expect(inbox.messages[0].summary).toBe('urgent');
  });

  it('replyTo flows into envelope (when replyTo exists in store)', async () => {
    const peerId = seedPeer('bob');
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    // 先送一条"前置消息"，拿到 msg id，作为后续 replyTo
    await runSendToAgent(env, comm, { to: `local:${peerId}`, content: 'first' });
    const firstInbox = store.listInbox(peerId, { peek: true });
    const firstId = firstInbox.messages[0].id;
    // 再送一条引用前一条
    await runSendToAgent(env, comm, {
      to: `local:${peerId}`, content: 'ref', replyTo: firstId,
    });
    const inbox = store.listInbox(peerId, { peek: true });
    const refMsg = inbox.messages.find((m) => m.replyTo !== null);
    expect(refMsg?.replyTo).toBe(firstId);
  });

  it('leader target works (isLeader peer)', async () => {
    const leaderId = seedPeer('alice', true);
    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, {
      to: `local:${leaderId}`, content: 'kickoff',
    });
    expect(res).toEqual({ delivered: true, to: `local:${leaderId}` });
    expect(store.listInbox(leaderId, { peek: true }).total).toBe(1);
  });
});

describe('runSendToAgent · lookup path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('alias → lookup resolves address → delivered', async () => {
    const peerId = seedPeer('laowang');
    let lookupCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/roster/search')) {
        lookupCalls++;
        expect(url).toContain(`callerInstanceId=${PRIMARY_ID}`);
        return new Response(JSON.stringify({
          match: 'single',
          target: { address: `local:${peerId}`, alias: '老王', memberName: 'laowang', instanceId: peerId },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, { to: '老王', content: 'hi' });
    expect(lookupCalls).toBe(1);
    expect(res).toEqual({ delivered: true, to: `local:${peerId}` });
    expect(store.listInbox(peerId, { peek: true }).total).toBe(1);
  });

  it('lookup match="none" → error, nothing stored', async () => {
    const peerId = seedPeer('bob');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ match: 'none', query: 'ghost' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const { router, store } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, { to: 'ghost', content: 'x' });
    expect((res as { error: string }).error).toContain("no member matches 'ghost'");
    expect(store.listInbox(peerId, { peek: true }).total).toBe(0);
  });

  it('lookup match="multiple" → error listing candidates', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        match: 'multiple',
        candidates: [
          { address: 'local:a', alias: '阿强', memberName: 'aq', instanceId: 'a' },
          { address: 'local:b', alias: '阿强2', memberName: 'aq2', instanceId: 'b' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const { router } = makeRouter();
    const comm = makeComm(router);
    const res = await runSendToAgent(env, comm, { to: '阿强', content: 'x' });
    const err = (res as { error: string }).error;
    expect(err).toContain('multiple');
    expect(err).toContain('阿强');
  });
});
