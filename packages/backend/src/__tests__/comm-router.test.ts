// comm-router W2-C 单测 — 覆盖 REGRESSION §2.2 U-70 ~ U-79。
// 不 mock db：用 TEAM_HUB_V2_DB=:memory: 真实 SQLite；spy store 仅覆盖 insert 计数。
// 不 mock bus：用独立 `new EventBus()` 观察 emit。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CommRouter, type DriverDispatcher } from '../comm/router.js';
import { CommRegistry } from '../comm/registry.js';
import { createMessageStore, type MessageStore } from '../comm/message-store.js';
import type { MessageEnvelope } from '../comm/envelope.js';
import type { Connection } from '../comm/types.js';
import type { BusEvent } from '../bus/events.js';
import { EventBus } from '../bus/events.js';
import { getDb, closeDb } from '../db/connection.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_PATH = resolve(HERE, '..', 'comm', 'router.ts');

// 测试 fixture：messages.to_instance_id FK → role_instances(id)
function bootstrapFixtures(): void {
  const db = getDb();
  db.exec(
    `INSERT INTO role_templates (name, role, created_at, updated_at)
     VALUES ('t', 'worker', '2026-04-25T00:00:00.000Z', '2026-04-25T00:00:00.000Z')`,
  );
  const mk = (id: string) =>
    db
      .prepare(
        `INSERT INTO role_instances (id, template_name, member_name, status, created_at)
         VALUES (?, 't', ?, 'ACTIVE', '2026-04-25T00:00:00.000Z')`,
      )
      .run(id, id);
  mk('inst_alice');
  mk('inst_bob');
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    from: {
      kind: 'agent',
      address: 'local:inst_alice',
      displayName: 'Alice',
      instanceId: 'inst_alice',
      memberName: 'alice',
    },
    to: {
      kind: 'agent',
      address: 'local:inst_bob',
      displayName: 'Bob',
      instanceId: 'inst_bob',
      memberName: 'bob',
    },
    teamId: null,
    kind: 'chat',
    summary: 'hello',
    content: 'body',
    replyTo: null,
    ts: '2026-04-25T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

function systemEnvelope(to = 'local:system'): MessageEnvelope {
  return envelope({
    id: 'msg_sys_1',
    from: {
      kind: 'system',
      address: 'local:system',
      displayName: '系统',
      instanceId: null,
      memberName: null,
    },
    to: {
      kind: 'system',
      address: to,
      displayName: '系统',
      instanceId: null,
      memberName: null,
    },
    kind: 'system',
  });
}

function remoteEnvelope(): MessageEnvelope {
  return envelope({
    id: 'msg_remote_1',
    to: {
      kind: 'agent',
      address: 'remote:peer-hub:inst_x',
      displayName: 'Peer',
      instanceId: 'inst_x',
      memberName: 'peer',
    },
  });
}

function droppedEnvelope(): MessageEnvelope {
  const env = envelope({ id: 'msg_dropped_1' });
  // parseAddress 要求 `<scope>:<id>`；空 id / 无冒号都会 throw。
  (env.to as { address: string }).address = 'badaddress';
  return env;
}

function fakeConn(): Connection & { written: string[]; destroyed: boolean } {
  const written: string[] = [];
  return {
    destroyed: false,
    write(chunk: string | Uint8Array): boolean {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
    written,
  } as unknown as Connection & { written: string[]; destroyed: boolean };
}

/**
 * 插入计数 spy。Why 不透传到真实 store：
 * - router.dispatch 的 "U-76 入口唯一性" 单测要覆盖 to='local:system' 路径，
 *   而真实 DAO 因 schema to_instance_id NOT NULL 会在系统目的地抛错；
 *   spy 只关心 router 是否调了 insert，DB 行为由 message-store 单测兜底。
 * - 其它需要真实 DAO 行为（replay markRead）的测试直接用 createMessageStore()。
 */
function spyStore(): MessageStore & { insertCalls: MessageEnvelope[] } {
  const insertCalls: MessageEnvelope[] = [];
  let nextId = 1;
  const noop = {
    insertCalls,
    insert(env: MessageEnvelope) {
      insertCalls.push(env);
      return nextId++;
    },
    findById: () => null,
    markRead: () => 0,
    listInbox: () => ({ messages: [], total: 0 }),
    listTeamHistory: () => ({ items: [], nextBefore: null, hasMore: false }),
    findUnreadFor: () => [],
  };
  return noop as unknown as MessageStore & { insertCalls: MessageEnvelope[] };
}

let registry: CommRegistry;
let store: MessageStore & { insertCalls: MessageEnvelope[] };
let eventBus: EventBus;
let sentEvents: BusEvent[];
let receivedEvents: BusEvent[];

beforeEach(() => {
  closeDb();
  getDb();
  bootstrapFixtures();
  registry = new CommRegistry();
  store = spyStore();
  eventBus = new EventBus();
  sentEvents = [];
  receivedEvents = [];
  eventBus.on('comm.message_sent').subscribe((e) => sentEvents.push(e));
  eventBus.on('comm.message_received').subscribe((e) => receivedEvents.push(e));
});

afterEach(() => {
  eventBus.destroy();
  closeDb();
});

describe('CommRouter.dispatch — W2-C (U-70 ~ U-79)', () => {
  it('U-71 system 路由 → 调 systemHandler + route="system"', async () => {
    const calls: MessageEnvelope[] = [];
    const router = new CommRouter({ registry, messageStore: store, eventBus });
    // systemHandler 拿到的是 legacy Message；断言 id 一致即可
    router.setSystemHandler((m) => {
      calls.push(envelope({ id: m.id }));
    });
    const env = systemEnvelope();
    const out = await router.dispatch(env);
    expect(out).toEqual({ route: 'system' });
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe(env.id);
  });

  it('U-72 driver delivered → local-online，不调 socket', async () => {
    const capture: { id: string; text: string }[] = [];
    const dispatcher: DriverDispatcher = async (id, text) => {
      capture.push({ id, text });
      return 'delivered';
    };
    const conn = fakeConn();
    registry.register('local:inst_bob', conn);

    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const env = envelope();
    const out = await router.dispatch(env);

    expect(out).toEqual({ route: 'local-online', address: 'local:inst_bob' });
    expect(capture.length).toBe(1);
    expect(capture[0].id).toBe('inst_bob');
    expect(conn.written.length).toBe(0);
  });

  it('U-73 driver not-ready + 无 socket → local-offline, stored=true', async () => {
    const dispatcher: DriverDispatcher = async () => 'not-ready';
    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const out = await router.dispatch(envelope());
    expect(out.route).toBe('local-offline');
    if (out.route === 'local-offline') {
      expect(out.stored).toBe(true);
      expect(out.address).toBe('local:inst_bob');
    }
  });

  it('U-73b driver not-ready + 在线 socket → fallback socket（仍 online）', async () => {
    const dispatcher: DriverDispatcher = async () => 'not-ready';
    const conn = fakeConn();
    registry.register('local:inst_bob', conn);
    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const out = await router.dispatch(envelope());
    expect(out).toEqual({ route: 'local-online', address: 'local:inst_bob' });
    expect(conn.written.length).toBe(1);
  });

  it('U-74 remote-unsupported → 不落库 / 不 emit', async () => {
    const router = new CommRouter({ registry, messageStore: store, eventBus });
    const out = await router.dispatch(remoteEnvelope());
    expect(out.route).toBe('remote-unsupported');
    expect(store.insertCalls.length).toBe(0);
    expect(sentEvents.length).toBe(0);
  });

  it('U-75 dropped（非法地址） → 不落库 / 不 emit', async () => {
    const router = new CommRouter({ registry, messageStore: store, eventBus });
    const out = await router.dispatch(droppedEnvelope());
    expect(out.route).toBe('dropped');
    expect(store.insertCalls.length).toBe(0);
    expect(sentEvents.length).toBe(0);
  });

  it('U-76 落库入口唯一：system/online/offline 成功路径各 insert 1 次', async () => {
    // system
    const r1 = new CommRouter({ registry, messageStore: store, eventBus });
    r1.setSystemHandler(() => void 0);
    await r1.dispatch(systemEnvelope());

    // driver delivered (online)
    const r2 = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: async () => 'delivered',
    });
    await r2.dispatch(envelope({ id: 'msg_online_1' }));

    // offline
    const r3 = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: async () => 'not-ready',
    });
    await r3.dispatch(envelope({ id: 'msg_offline_1' }));

    expect(store.insertCalls.length).toBe(3);

    // dropped / remote 不增计数
    await r1.dispatch(remoteEnvelope());
    await r1.dispatch(droppedEnvelope());
    expect(store.insertCalls.length).toBe(3);
  });

  it('U-77 comm.message_sent 每条成功 dispatch emit 恰好一次', async () => {
    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: async () => 'delivered',
    });
    await router.dispatch(envelope({ id: 'msg_e1' }));
    await router.dispatch(envelope({ id: 'msg_e2' }));
    expect(sentEvents.length).toBe(2);
    const ids = sentEvents.map((e) => (e as { messageId: string }).messageId).sort();
    expect(ids).toEqual(['msg_e1', 'msg_e2']);
    // received 也是两次（driver 路径）；其中 route='driver'
    expect(receivedEvents.length).toBe(2);
    expect(receivedEvents.every((e) => (e as { route: string }).route === 'driver')).toBe(true);
  });

  it('U-78 notifyLine 精确匹配正则', async () => {
    let got = '';
    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: async (_id, text) => {
        got = text;
        return 'delivered';
      },
    });
    await router.dispatch(envelope({ id: 'msg_fmt_1', summary: '你好' }));
    expect(got).toBe('@Alice>你好  [msg_id=msg_fmt_1]');
    expect(/^@[^>]+>.+ {2}\[msg_id=msg_[A-Za-z0-9_-]+\]$/.test(got)).toBe(true);
  });

  it('U-79 extractText 已删除 / router.ts 源里零匹配', () => {
    const src = readFileSync(ROUTER_PATH, 'utf8');
    expect(/function\s+extractText/.test(src)).toBe(false);
    expect(/extractText\(/.test(src)).toBe(false);
  });

  it('U-77b socket 路径 received route="socket"', async () => {
    const conn = fakeConn();
    registry.register('local:inst_bob', conn);
    const router = new CommRouter({ registry, messageStore: store, eventBus });
    const out = await router.dispatch(envelope({ id: 'msg_sk_1' }));
    expect(out).toEqual({ route: 'local-online', address: 'local:inst_bob' });
    expect(receivedEvents.length).toBe(1);
    expect((receivedEvents[0] as { route: string }).route).toBe('socket');
  });

  it('W2-2 store.insert 抛错 → dropped store-failure（不传播）', async () => {
    const boomStore = {
      insert: () => {
        throw new Error('db locked');
      },
      findById: () => null,
      markRead: () => 0,
      listInbox: () => ({ messages: [], total: 0 }),
      listTeamHistory: () => ({ items: [], nextBefore: null, hasMore: false }),
      findUnreadFor: () => [],
    } as unknown as MessageStore;
    const router = new CommRouter({ registry, messageStore: boomStore, eventBus });
    const out = await router.dispatch(envelope({ id: 'msg_boom_1' }));
    expect(out.route).toBe('dropped');
    if (out.route === 'dropped') {
      expect(out.reason).toBe('store-failure');
      expect(out.detail).toBe('db locked');
    }
    // 失败路径不得 emit comm.message_sent / received
    expect(sentEvents.length).toBe(0);
    expect(receivedEvents.length).toBe(0);
  });

  it('dispatcher 抛错 → 吞异常 → 回退 socket', async () => {
    const dispatcher: DriverDispatcher = async () => {
      throw new Error('boom');
    };
    const conn = fakeConn();
    registry.register('local:inst_bob', conn);
    const router = new CommRouter({
      registry,
      messageStore: store,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const out = await router.dispatch(envelope({ id: 'msg_throw_1' }));
    expect(out).toEqual({ route: 'local-online', address: 'local:inst_bob' });
    expect(conn.written.length).toBe(1);
  });
});

describe('CommRouter.replay — W2-C / W2-7', () => {
  it('回灌走新通知行（带 msg_id）+ markRead', async () => {
    // 先把 bob 离线消息直接 insert 进库
    const realStore = createMessageStore();
    realStore.insert(
      envelope({ id: 'msg_repl_1', summary: 'S1', ts: '2026-04-25T10:00:00.000Z' }),
    );
    realStore.insert(
      envelope({ id: 'msg_repl_2', summary: 'S2', ts: '2026-04-25T10:01:00.000Z' }),
    );

    const captured: string[] = [];
    const dispatcher: DriverDispatcher = async (_id, text) => {
      captured.push(text);
      return 'delivered';
    };
    const router = new CommRouter({
      registry,
      messageStore: realStore,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const n = await router.replay('local:inst_bob');

    expect(n).toBe(2);
    expect(captured.length).toBe(2);
    expect(captured[0]).toMatch(/^@Alice>S1 {2}\[msg_id=msg_repl_1\]$/);
    expect(captured[1]).toMatch(/^@Alice>S2 {2}\[msg_id=msg_repl_2\]$/);
    // markRead 落到真实库
    expect(realStore.findUnreadFor('inst_bob').length).toBe(0);
  });

  it('W2-7 driver 抛错 & 无 socket → 消息保留未读（write 失败不 markRead）', async () => {
    const realStore = createMessageStore();
    realStore.insert(envelope({ id: 'msg_fail_1', summary: 'S1' }));
    realStore.insert(envelope({ id: 'msg_fail_2', summary: 'S2' }));

    const dispatcher: DriverDispatcher = async () => {
      throw new Error('driver boom');
    };
    const router = new CommRouter({
      registry,
      messageStore: realStore,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const n = await router.replay('local:inst_bob');

    expect(n).toBe(0);
    expect(realStore.findUnreadFor('inst_bob').length).toBe(2);
  });

  it('W2-7 driver not-ready & 无 socket → 消息保留未读', async () => {
    const realStore = createMessageStore();
    realStore.insert(envelope({ id: 'msg_nr_1', summary: 'S1' }));

    const dispatcher: DriverDispatcher = async () => 'not-ready';
    const router = new CommRouter({
      registry,
      messageStore: realStore,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const n = await router.replay('local:inst_bob');

    expect(n).toBe(0);
    expect(realStore.findUnreadFor('inst_bob').length).toBe(1);
  });

  it('W2-7 driver not-ready 但 socket 在线 → fallback socket，markRead', async () => {
    const realStore = createMessageStore();
    realStore.insert(envelope({ id: 'msg_sock_1', summary: 'S1' }));

    const conn = fakeConn();
    registry.register('local:inst_bob', conn);
    const dispatcher: DriverDispatcher = async () => 'not-ready';
    const router = new CommRouter({
      registry,
      messageStore: realStore,
      eventBus,
      driverDispatcher: dispatcher,
    });
    const n = await router.replay('local:inst_bob');

    expect(n).toBe(1);
    expect(conn.written.length).toBe(1);
    expect(realStore.findUnreadFor('inst_bob').length).toBe(0);
  });
});
