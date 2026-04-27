// 契约测试：createMteamServer 返回的 Server 能正确响应 ListTools / CallTool。
// 允许 mock CommLike —— 工具层对 comm 的调用形状是本测试的一等断言。
// 不 mock 的是 ALL_TOOLS / visibleTools —— 走真实 registry。
import { describe, it, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMteamServer } from './server.js';
import type { CommLike } from './comm-like.js';
import type { MteamEnv } from './config.js';

function makeEnv(isLeader: boolean): MteamEnv {
  return {
    instanceId: 'instance-test',
    hubUrl: 'http://localhost:0',
    commSock: '',
    isLeader,
  };
}

function makeStubComm(): CommLike & { sent: Array<{ to: string; payload: Record<string, unknown> }> } {
  const sent: Array<{ to: string; payload: Record<string, unknown> }> = [];
  return {
    sent,
    ensureReady: async () => {},
    send: async (opts) => {
      sent.push({ to: opts.to, payload: opts.payload });
    },
    close: () => {},
  };
}

async function connectPair(env: MteamEnv, comm: CommLike): Promise<Client> {
  const server = createMteamServer(env, comm);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

describe('createMteamServer · ListTools', () => {
  it('leader sees all 8 tools', async () => {
    const client = await connectPair(makeEnv(true), makeStubComm());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain('request_offline');
    expect(names).toContain('add_member');
    await client.close();
  });

  it('non-leader hides leaderOnly tools', async () => {
    const client = await connectPair(makeEnv(false), makeStubComm());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('request_offline');
    expect(names).not.toContain('add_member');
    expect(tools.length).toBeLessThan(8);
    await client.close();
  });
});

describe('createMteamServer · CallTool', () => {
  it('unknown tool returns isError text result', async () => {
    const client = await connectPair(makeEnv(true), makeStubComm());
    const res = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('unknown tool');
    await client.close();
  });

  it('leader-only tool rejected for non-leader', async () => {
    const client = await connectPair(makeEnv(false), makeStubComm());
    const res = await client.callTool({ name: 'request_offline', arguments: { instanceId: 'x' } });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('leader-only');
    await client.close();
  });

  it('send_msg address path routes to CommLike.send', async () => {
    const comm = makeStubComm();
    const client = await connectPair(makeEnv(false), comm);
    const res = await client.callTool({
      name: 'send_msg',
      arguments: { to: 'local:peer-1', summary: 'hi', content: 'hello' },
    });
    expect(res.isError).toBeUndefined();
    expect(comm.sent.length).toBe(1);
    expect(comm.sent[0].to).toBe('local:peer-1');
    expect(comm.sent[0].payload).toEqual({ summary: 'hi', content: 'hello', kind: 'chat' });
    await client.close();
  });
});
