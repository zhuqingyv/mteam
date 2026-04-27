// mcp-http listener 端到端契约测试。真 HTTP + 真 CommRouter + 真 MCP Client。
// 不 mock bus，用真 CommRegistry / driverDispatcher 观察 send_msg 是否打到
// 路由器。对 /mcp/searchTools 用临时 http server 替代 hub 回调。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommRouter, type DriverDispatcher } from '../comm/router.js';
import { CommRegistry } from '../comm/registry.js';
import type { MessageStore } from '../comm/message-store.js';
import { startMcpHttpServer, type McpHttpHandle } from './index.js';
import { InProcessComm } from './in-process-comm.js';
import type { Address, Message } from '../comm/types.js';
import type { MessageEnvelope } from '../comm/envelope.js';

// spy store：不碰 DB；router 只关心 insert 被调一次。
function fakeStore(): MessageStore {
  return {
    insert: () => 1,
    findById: () => null,
    markRead: () => 0,
    listInbox: () => ({ messages: [], total: 0 }),
    listTeamHistory: () => ({ items: [], nextBefore: null, hasMore: false }),
    findUnreadFor: () => [],
    findUnreadForAddress: () => [],
    findMessagesAfter: () => [],
  };
}

async function connectMteam(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Client> {
  const client = new Client({ name: 't', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/mteam`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

describe('startMcpHttpServer · mteam route', () => {
  let handle: McpHttpHandle;
  const dispatched: Array<{ id: string; text: string }> = [];
  const dispatcher: DriverDispatcher = async (id, text) => {
    dispatched.push({ id, text });
    return 'delivered';
  };
  const registry = new CommRegistry();
  const router = new CommRouter({
    registry,
    messageStore: fakeStore(),
    driverDispatcher: dispatcher,
  });

  beforeAll(async () => {
    handle = await startMcpHttpServer({
      port: 0,
      hubUrl: 'http://localhost:0',
      commRouter: router,
    });
  });
  afterAll(async () => { await handle.close(); });

  it('ListTools returns leader-only tools when X-Is-Leader=1', async () => {
    const client = await connectMteam(handle.url, {
      'X-Role-Instance-Id': 'inst-a',
      'X-Is-Leader': '1',
    });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('request_offline');
    expect(names).toContain('add_member');
    await client.close();
  });

  it('non-leader hides leader-only tools', async () => {
    const client = await connectMteam(handle.url, {
      'X-Role-Instance-Id': 'inst-b',
      'X-Is-Leader': '0',
    });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('request_offline');
    await client.close();
  });

  it('send_msg with address routes through CommRouter (dispatcher observed)', async () => {
    dispatched.length = 0;
    const client = await connectMteam(handle.url, {
      'X-Role-Instance-Id': 'inst-c',
      'X-Is-Leader': '0',
    });
    const res = await client.callTool({
      name: 'send_msg',
      arguments: { to: 'local:peer-x', summary: 'hi', content: 'body-c' },
    });
    expect(res.isError).toBeUndefined();
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].id).toBe('peer-x');
    // W2-C 起：dispatcher 收到的是 notifyLine（summary + msg_id），不含 content
    expect(dispatched[0].text).toContain('hi');
    expect(dispatched[0].text).toMatch(/\[msg_id=msg_/);
    await client.close();
  });

  it('missing X-Role-Instance-Id returns 400', async () => {
    const r = await fetch(`${handle.url}/mcp/mteam`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(r.status).toBe(400);
  });
});

describe('startMcpHttpServer · searchTools route', () => {
  let handle: McpHttpHandle;
  let hub: http.Server;
  let hubPort = 0;
  const registry = new CommRegistry();
  const router = new CommRouter({ registry, messageStore: fakeStore() });

  beforeAll(async () => {
    hub = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/mcp-tools/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hits: [{ mcpServer: 'm', toolName: 't', description: 'd' }] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', () => r()));
    hubPort = (hub.address() as { port: number }).port;
    handle = await startMcpHttpServer({
      port: 0,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      commRouter: router,
    });
  });
  afterAll(async () => {
    await handle.close();
    await new Promise<void>((r) => hub.close(() => r()));
  });

  it('CallTool search returns hits from hub', async () => {
    const client = new Client({ name: 't', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp/searchTools`), {
      requestInit: { headers: { 'X-Role-Instance-Id': 'inst-s' } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search');
    const res = await client.callTool({ name: 'search', arguments: { query: 'foo' } });
    expect(res.isError).toBeUndefined();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('hits');
    await client.close();
  });
});

describe('InProcessComm · 直连 CommRouter', () => {
  it('send() 落到 router.dispatch', async () => {
    const registry = new CommRegistry();
    const seen: Message[] = [];
    const router = new CommRouter({
      registry,
      messageStore: fakeStore(),
      driverDispatcher: async (_id, _text) => {
        return 'delivered';
      },
    });
    // 注入一个 spy system handler 来观察 local:system 消息。
    router.setSystemHandler((msg) => seen.push(msg));
    const comm = new InProcessComm({ router, selfAddress: 'local:me' });
    await comm.ensureReady();
    await comm.send({ to: 'local:system' as Address, payload: { hello: 1 } });
    expect(seen.length).toBe(1);
    expect(seen[0].from).toBe('local:me');
  });

  // W1-A：fromLookup 通过 lookupAgent 补 displayName；查不到则退回 instanceId。
  function spyStore(captured: MessageEnvelope[]): MessageStore {
    const base = fakeStore();
    return { ...base, insert: (env) => { captured.push(env); return 1; } };
  }

  it('W1-A: lookupAgent 命中 → envelope.from.displayName 用 alias', async () => {
    const captured: MessageEnvelope[] = [];
    const router = new CommRouter({
      registry: new CommRegistry(),
      messageStore: spyStore(captured),
      driverDispatcher: async () => 'delivered',
    });
    const comm = new InProcessComm({
      router,
      selfAddress: 'local:inst-老王',
      lookupAgent: (id) =>
        id === 'inst-老王'
          ? { instanceId: id, memberName: 'wang', displayName: '老王' }
          : null,
    });
    await comm.send({ to: 'local:peer-x' as Address, payload: { summary: 'hi' } });
    expect(captured.length).toBe(1);
    expect(captured[0].from.displayName).toBe('老王');
    expect(captured[0].from.memberName).toBe('wang');
    expect(captured[0].from.instanceId).toBe('inst-老王');
  });

  it('W1-A: lookupAgent 返回 null → fail-soft 用 instanceId 兜底', async () => {
    const captured: MessageEnvelope[] = [];
    const router = new CommRouter({
      registry: new CommRegistry(),
      messageStore: spyStore(captured),
      driverDispatcher: async () => 'delivered',
    });
    const comm = new InProcessComm({
      router,
      selfAddress: 'local:unknown-id',
      lookupAgent: () => null,
    });
    await comm.send({ to: 'local:peer-y' as Address, payload: { summary: 'hi' } });
    expect(captured.length).toBe(1);
    expect(captured[0].from.displayName).toBe('unknown-id');
    expect(captured[0].from.instanceId).toBe('unknown-id');
  });
});
