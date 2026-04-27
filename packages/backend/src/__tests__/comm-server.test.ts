// CommServer 构造透传 driverDispatcher 路径单测。
// 起真实 UNIX socket server，客户端发 register + message，验 dispatcher 被触发。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { CommServer } from '../comm/server.js';
import type { DriverDispatcher } from '../comm/router.js';
import type { MessageStore } from '../comm/message-store.js';
import { closeDb, getDb } from '../db/connection.js';

// spy store：绕开 messages FK（测试 fixture 没预建 role_instances）。
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

function randomSockPath(): string {
  return join(tmpdir(), `comm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

async function connectClient(sockPath: string): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function write(s: net.Socket, obj: unknown): void {
  s.write(JSON.stringify(obj) + '\n');
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let server: CommServer | null = null;
let sockPath = '';

beforeEach(() => {
  closeDb();
  getDb();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (sockPath && existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  }
  closeDb();
});

describe('CommServer — driverDispatcher 透传', () => {
  it('构造时不传 dispatcher → 老行为（socket register+dispatch 正常）', async () => {
    server = new CommServer({ messageStore: fakeStore() });
    sockPath = randomSockPath();
    await server.start(sockPath);

    // 两个客户端：一个注册 m1 一个注册 sender，sender 发消息给 m1。
    const recv = await connectClient(sockPath);
    const send = await connectClient(sockPath);
    const received: string[] = [];
    recv.on('data', (d) => received.push(d.toString('utf8')));

    write(recv, { type: 'register', address: 'local:m-recv' });
    write(send, { type: 'register', address: 'local:m-send' });
    await waitMs(50);

    write(send, {
      type: 'message',
      id: 'mm-1',
      from: 'local:m-send',
      to: 'local:m-recv',
      payload: { summary: 'ping' },
      ts: new Date().toISOString(),
    });
    await waitMs(50);

    const joined = received.join('');
    expect(joined).toContain('ping');

    recv.destroy();
    send.destroy();
  });

  it('构造时传 dispatcher → message 走 dispatcher 优先', async () => {
    const calls: Array<{ id: string; text: string }> = [];
    const dispatcher: DriverDispatcher = async (id, text) => {
      calls.push({ id, text });
      return 'delivered';
    };
    server = new CommServer({ driverDispatcher: dispatcher, messageStore: fakeStore() });
    sockPath = randomSockPath();
    await server.start(sockPath);

    const send = await connectClient(sockPath);
    write(send, { type: 'register', address: 'local:sender' });
    await waitMs(30);

    write(send, {
      type: 'message',
      id: 'mm-2',
      from: 'local:sender',
      to: 'local:m-target',
      payload: { summary: 'hey' },
      ts: new Date().toISOString(),
    });
    await waitMs(50);

    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe('m-target');
    // W2-C 起：dispatcher 收到的是 notifyLine（含 summary + msg_id）
    expect(calls[0].text).toContain('hey');
    expect(calls[0].text).toContain('[msg_id=mm-2]');

    send.destroy();
  });

  it("dispatcher 'not-found' 且无 socket → 消息落 offline（route 不暴露，观察 dispatcher 调用 + ack）", async () => {
    let called = 0;
    const dispatcher: DriverDispatcher = async () => {
      called++;
      return 'not-found';
    };
    server = new CommServer({ driverDispatcher: dispatcher, messageStore: fakeStore() });
    sockPath = randomSockPath();
    await server.start(sockPath);

    const send = await connectClient(sockPath);
    const acks: string[] = [];
    send.on('data', (d) => acks.push(d.toString('utf8')));
    write(send, { type: 'register', address: 'local:s2' });
    await waitMs(30);

    write(send, {
      type: 'message',
      id: 'mm-3',
      from: 'local:s2',
      to: 'local:not-exist',
      payload: { summary: 'x' },
      ts: new Date().toISOString(),
    });
    await waitMs(50);

    expect(called).toBe(1);
    // ack 一定会回给发送方
    expect(acks.join('')).toContain('"type":"ack"');

    send.destroy();
  });
});
