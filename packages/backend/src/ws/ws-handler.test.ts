// ws-handler 单测。不 mock db/bus：用 :memory: SQLite + 真 SubscriptionManager + 真 DriverRegistry
// + 真 CommRouter + 真 MessageStore + 真 EventBus。WsLike 用 EventEmitter 模拟。
//
// 覆盖 TASK-LIST W2-1 完成判据 2：subscribe(无/有 lastMsgId) / prompt(not_ready/ready) / ping / bad json；
// + REGRESSION R1-10 user 越权；
// + phase-ws prompt-via-dispatch：envelope from.kind='user'、instance 不存在 / driver not ready
//   都不进 dispatch、dispatch dropped → error、dispatch 成功 → message_store 有记录 + 发 comm.message_sent。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SubscriptionManager } from './subscription-manager.js';
import { DriverRegistry } from '../agent-driver/registry.js';
import { CommRegistry } from '../comm/registry.js';
import { createMessageStore, type MessageStore } from '../comm/message-store.js';
import { CommRouter, type DispatchOutcome } from '../comm/router.js';
import { createDriverDispatcher } from '../comm/driver-dispatcher.js';
import { EventBus } from '../bus/events.js';
import { getDb, closeDb } from '../db/connection.js';
import { lookupAgentByInstanceId } from '../comm/agent-lookup.js';
import {
  attachWsHandler,
  type ConnectionContext,
  type WsLike,
  type WsPrimaryAgentAdapter,
  type WsTurnAggregatorReader,
} from './ws-handler.js';
import type { ListRecentOpts, ListRecentResult } from '../turn-history/repo.js';
import type { AgentDriver } from '../agent-driver/driver.js';
import type { AgentLookup } from '../comm/envelope-builder.js';
import type { MessageEnvelope } from '../comm/envelope.js';
import type {
  BusEvent,
  CommMessageSentEvent,
  PrimaryAgentConfiguredEvent,
} from '../bus/types.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from '../primary-agent/types.js';
import { PrimaryAgent } from '../primary-agent/primary-agent.js';
import { cliManager } from '../cli-scanner/manager.js';
import type {
  ProcessRuntime,
  RuntimeHandle,
  LaunchSpec,
} from '../process-runtime/types.js';

// ---------- fake WS ----------

interface FakeWs extends WsLike {
  emit(type: 'message', raw: unknown): boolean;
  sent: string[];
}

function fakeWs(): FakeWs {
  const ee = new EventEmitter();
  const sent: string[] = [];
  const ws: FakeWs = {
    sent,
    send(data: string) {
      sent.push(data);
    },
    on(type, listener) {
      ee.on(type, listener as (...args: unknown[]) => void);
    },
    close() {
      /* noop */
    },
    emit(type, raw) {
      return ee.emit(type, raw);
    },
  };
  return ws;
}

function last(ws: FakeWs): unknown {
  const s = ws.sent[ws.sent.length - 1];
  return s === undefined ? undefined : JSON.parse(s);
}

function allDown(ws: FakeWs): unknown[] {
  return ws.sent.map((s) => JSON.parse(s));
}

async function flush(): Promise<void> {
  // 等 handlePrompt 内部 await dispatch 跑完；两轮 microtask 足够覆盖 Promise.resolve 链。
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------- stub driver ----------

interface StubDriver {
  id: string;
  ready: boolean;
  promptCalls: string[];
  isReady(): boolean;
  prompt(msg: string): Promise<void>;
}

function stubDriver(id: string, ready: boolean): StubDriver {
  return {
    id,
    ready,
    promptCalls: [],
    isReady() {
      return this.ready;
    },
    async prompt(msg: string) {
      this.promptCalls.push(msg);
    },
  };
}

// ---------- PrimaryAgent test fixtures（R2 要求真 PrimaryAgent + FakeRuntime）----------

class FakeAcpHandle implements RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid = 12345;
  killed = false;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  constructor(private readonly spawnDelayMs: number) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let buf = '';
    this.stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          let m: { id?: number | string; method?: string };
          try { m = JSON.parse(s); } catch { continue; }
          if (m.id === undefined || !m.method) continue;
          const r = synthResp(m.id, m.method);
          if (r) this.stdoutCtrl.enqueue(enc.encode(JSON.stringify(r) + '\n'));
        }
      },
    });
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => { this.stdoutCtrl = c; },
    });
  }
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    try { this.stdoutCtrl.close(); } catch { /* ignore */ }
    this.exitCb?.(0, null);
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }
}

function synthResp(id: number | string, method: string): Record<string, unknown> | null {
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  }
  if (method === 'session/new') {
    return { jsonrpc: '2.0', id, result: { sessionId: 'sess-fake' } };
  }
  return { jsonrpc: '2.0', id, result: {} };
}

class FakePrimaryRuntime implements ProcessRuntime {
  handles: FakeAcpHandle[] = [];
  specs: LaunchSpec[] = [];
  spawnDelayMs = 0;
  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    this.specs.push(spec);
    if (this.spawnDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    }
    const h = new FakeAcpHandle(this.spawnDelayMs);
    this.handles.push(h);
    return h;
  }
  async isAvailable(): Promise<boolean> { return true; }
  async destroy(): Promise<void> {}
}

function stubCliSnapshot(): void {
  const snap = (cliManager as unknown as { snapshot: Map<string, unknown> }).snapshot;
  snap.set('claude', { name: 'claude', available: true, path: '/fake/claude', version: '0.0.0' });
  snap.set('codex', { name: 'codex', available: true, path: '/fake/codex', version: '0.0.0' });
  // bogus 不设置 → isAvailable('bogus') = false，用于 R2-2
}

// ---------- fixtures ----------

function bootstrapDb(): void {
  const db = getDb();
  db.exec(
    `INSERT INTO role_templates (name, role, created_at, updated_at)
     VALUES ('t', 'worker', '2026-04-25T00:00:00.000Z', '2026-04-25T00:00:00.000Z')`,
  );
  db.prepare(
    `INSERT INTO role_instances (id, template_name, member_name, status, created_at)
     VALUES (?, 't', ?, 'ACTIVE', '2026-04-25T00:00:00.000Z')`,
  ).run('inst_alice', 'inst_alice');
  db.prepare(
    `INSERT INTO role_instances (id, template_name, member_name, status, created_at)
     VALUES (?, 't', ?, 'ACTIVE', '2026-04-25T00:00:00.000Z')`,
  ).run('inst_bob', 'inst_bob');
  db.prepare(
    `INSERT INTO teams (id, name, leader_instance_id, created_at)
     VALUES ('team_01', 'T01', 'inst_alice', '2026-04-25T00:00:00.000Z')`,
  ).run();
}

function envelope(overrides: Partial<MessageEnvelope>): MessageEnvelope {
  return {
    id: 'msg_x',
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
    teamId: 'team_01',
    kind: 'chat',
    summary: 's',
    content: 'c',
    replyTo: null,
    ts: '2026-04-25T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

let subs: SubscriptionManager;
let drivers: DriverRegistry;
let comms: CommRegistry;
let store: MessageStore;
let eventBus: EventBus;
let router: CommRouter;

const ctx: ConnectionContext = { connectionId: 'c1', userId: 'u1' };

const noopPrimaryAgent: WsPrimaryAgentAdapter = {
  async configure(): Promise<PrimaryAgentRow> {
    throw new Error('unexpected configure in test');
  },
};

function buildDeps(overrides: {
  commRouter?: { dispatch: (env: MessageEnvelope) => Promise<DispatchOutcome> };
  lookupAgent?: (id: string) => AgentLookup | null;
  primaryAgent?: WsPrimaryAgentAdapter;
  getTurnAggregator?: () => WsTurnAggregatorReader | null;
  listTurnHistory?: (driverId: string, opts: ListRecentOpts) => ListRecentResult;
} = {}) {
  return {
    subscriptionManager: subs,
    driverRegistry: drivers,
    commRegistry: comms,
    gapReplayDeps: { messageStore: store, maxItems: 50 },
    commRouter: (overrides.commRouter ?? router) as unknown as CommRouter,
    lookupAgent: overrides.lookupAgent ?? lookupAgentByInstanceId,
    primaryAgent: overrides.primaryAgent ?? noopPrimaryAgent,
    getTurnAggregator: overrides.getTurnAggregator ?? (() => null),
    listTurnHistory:
      overrides.listTurnHistory ?? ((): ListRecentResult => ({ items: [], nextCursor: null })),
  };
}

beforeEach(() => {
  closeDb();
  getDb();
  bootstrapDb();
  subs = new SubscriptionManager();
  drivers = new DriverRegistry();
  comms = new CommRegistry();
  store = createMessageStore();
  eventBus = new EventBus();
  router = new CommRouter({
    registry: comms,
    messageStore: store,
    eventBus,
    driverDispatcher: createDriverDispatcher(drivers),
  });
  subs.addConn(ctx.connectionId);
});

afterAll(() => {
  closeDb();
});

// ---------- tests ----------

describe('ws-handler · subscribe', () => {
  it('不带 lastMsgId → 回 ack，订阅已记录', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({ op: 'subscribe', scope: 'team', id: 'team_01' }));

    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
    expect(subs.list(ctx.connectionId)).toEqual([{ scope: 'team', id: 'team_01' }]);
    expect(allDown(ws).some((m) => (m as { type: string }).type === 'gap-replay')).toBe(false);
  });

  it('带 lastMsgId → 先 gap-replay 再 ack，items 只含 id > lastMsgId', () => {
    store.insert(envelope({ id: 'msg_t00', ts: '2026-04-25T10:00:00.000Z' }));
    store.insert(envelope({ id: 'msg_t01', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'msg_t02', ts: '2026-04-25T10:02:00.000Z' }));

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({
      op: 'subscribe', scope: 'team', id: 'team_01', lastMsgId: 'msg_t00',
    }));

    const downs = allDown(ws);
    expect(downs).toHaveLength(2);
    const [replay, ack] = downs as Array<{ type: string; items?: Array<{ id: string }>; upTo?: string | null; ok?: boolean }>;
    expect(replay?.type).toBe('gap-replay');
    expect(replay?.items?.map((x) => x.id)).toEqual(['msg_t01', 'msg_t02']);
    expect(replay?.upTo).toBe('msg_t02');
    expect(ack?.type).toBe('ack');
    expect(ack?.ok).toBe(true);
  });

  it('user scope 订阅自己 → 放行；订阅他人 → forbidden (R1-10)', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());

    ws.emit('message', JSON.stringify({ op: 'subscribe', scope: 'user', id: 'u1' }));
    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
    expect(subs.list(ctx.connectionId)).toEqual([{ scope: 'user', id: 'u1' }]);

    ws.emit('message', JSON.stringify({ op: 'subscribe', scope: 'user', id: 'u2' }));
    expect(last(ws)).toEqual({ type: 'error', code: 'forbidden', message: 'cannot subscribe other user' });
    expect(subs.list(ctx.connectionId)).toEqual([{ scope: 'user', id: 'u1' }]);
  });
});

describe('ws-handler · unsubscribe', () => {
  it('回 ack，订阅被移除', () => {
    subs.subscribe(ctx.connectionId, { scope: 'team', id: 'team_01' });
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());

    ws.emit('message', JSON.stringify({ op: 'unsubscribe', scope: 'team', id: 'team_01' }));
    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
    expect(subs.list(ctx.connectionId)).toEqual([]);
  });
});

describe('ws-handler · prompt（走 CommRouter.dispatch）', () => {
  it('instance 不存在 → error{not_ready}，dispatch 未调', async () => {
    let called = 0;
    const spyRouter = {
      dispatch: async (_env: MessageEnvelope): Promise<DispatchOutcome> => {
        called++;
        return { route: 'local-online', address: _env.to.address };
      },
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ commRouter: spyRouter }));
    ws.emit('message', JSON.stringify({
      op: 'prompt', instanceId: 'inst_ghost', text: 'hi', requestId: 'r1',
    }));
    await flush();
    expect(last(ws)).toEqual({
      type: 'error', code: 'not_ready', message: 'driver inst_ghost not ready',
    });
    expect(called).toBe(0);
  });

  it('driver 未 READY → error{not_ready}，dispatch 未调', async () => {
    const drv = stubDriver('inst_alice', false);
    drivers.register('inst_alice', drv as unknown as AgentDriver);
    let called = 0;
    const spyRouter = {
      dispatch: async (): Promise<DispatchOutcome> => {
        called++;
        return { route: 'local-online', address: 'x' };
      },
    };

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ commRouter: spyRouter }));
    ws.emit('message', JSON.stringify({
      op: 'prompt', instanceId: 'inst_alice', text: 'hi',
    }));
    await flush();
    expect((last(ws) as { type: string }).type).toBe('error');
    expect(called).toBe(0);
    expect(drv.promptCalls).toEqual([]);
  });

  it('driver READY → dispatch 被调且 envelope from.kind="user"；ack{requestId} 回执', async () => {
    const drv = stubDriver('inst_alice', true);
    drivers.register('inst_alice', drv as unknown as AgentDriver);
    const captured: MessageEnvelope[] = [];
    const spyRouter = {
      dispatch: async (env: MessageEnvelope): Promise<DispatchOutcome> => {
        captured.push(env);
        return { route: 'local-online', address: env.to.address };
      },
    };

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ commRouter: spyRouter }));
    ws.emit('message', JSON.stringify({
      op: 'prompt', instanceId: 'inst_alice', text: 'hello', requestId: 'req_42',
    }));
    await flush();

    expect(captured).toHaveLength(1);
    const env = captured[0]!;
    expect(env.from.kind).toBe('user');
    expect(env.from.address).toBe('user:u1');
    expect(env.to.kind).toBe('agent');
    expect(env.to.address).toBe('local:inst_alice');
    expect(env.content).toBe('hello');
    expect(env.kind).toBe('chat');

    expect(last(ws)).toEqual({ type: 'ack', requestId: 'req_42', ok: true });
  });

  it('dispatch 返回 dropped → error{internal_error}', async () => {
    const drv = stubDriver('inst_alice', true);
    drivers.register('inst_alice', drv as unknown as AgentDriver);
    const spyRouter = {
      dispatch: async (): Promise<DispatchOutcome> =>
        ({ route: 'dropped', reason: 'bad-addr' }),
    };

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ commRouter: spyRouter }));
    ws.emit('message', JSON.stringify({
      op: 'prompt', instanceId: 'inst_alice', text: 'x', requestId: 'r',
    }));
    await flush();

    expect(last(ws)).toEqual({
      type: 'error', code: 'internal_error', message: 'dropped: bad-addr',
    });
  });

  it('集成：prompt → message_store 可查到 envelope + eventBus 触发 comm.message_sent', async () => {
    const drv = stubDriver('inst_alice', true);
    drivers.register('inst_alice', drv as unknown as AgentDriver);
    const sentEvents: CommMessageSentEvent[] = [];
    eventBus.on('comm.message_sent').subscribe((e) => sentEvents.push(e));

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({
      op: 'prompt', instanceId: 'inst_alice', text: 'hello-prompt', requestId: 'r',
    }));
    await flush();

    expect(last(ws)).toEqual({ type: 'ack', requestId: 'r', ok: true });
    // 集成到 driverDispatcher → drv.prompt 被调
    expect(drv.promptCalls).toHaveLength(1);
    expect(sentEvents).toHaveLength(1);
    const ev = sentEvents[0]!;
    expect(ev.from).toBe('user:u1');
    expect(ev.to).toBe('local:inst_alice');

    // message_store 有这条
    const persisted = store.findById(ev.messageId);
    expect(persisted).not.toBeNull();
    expect(persisted?.from.kind).toBe('user');
    expect(persisted?.content).toBe('hello-prompt');
  });
});

describe('ws-handler · ping', () => {
  it('回 pong{ts}', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({ op: 'ping' }));
    const msg = last(ws) as { type: string; ts: string };
    expect(msg.type).toBe('pong');
    expect(typeof msg.ts).toBe('string');
    expect(msg.ts.length).toBeGreaterThan(0);
  });
});

describe('ws-handler · 异常路径', () => {
  it('bad json → error{bad_request}，连接不断', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', 'not-json');
    expect(last(ws)).toEqual({ type: 'error', code: 'bad_request', message: 'json parse failed' });
    ws.emit('message', JSON.stringify({ op: 'ping' }));
    expect((last(ws) as { type: string }).type).toBe('pong');
  });

  it('schema 不合法 → error{bad_request}，连接不断', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({ op: 'ping', extra: 1 }));
    expect(last(ws)).toEqual({ type: 'error', code: 'bad_request', message: 'schema invalid' });
    ws.emit('message', JSON.stringify({ op: 'ping' }));
    expect((last(ws) as { type: string }).type).toBe('pong');
  });

  it('Buffer/Uint8Array 上行也能解析', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    const buf = new TextEncoder().encode(JSON.stringify({ op: 'ping' }));
    ws.emit('message', buf);
    expect((last(ws) as { type: string }).type).toBe('pong');
  });
});

describe('ws-handler · configure_primary_agent（R2-1~R2-4 · 真 PrimaryAgent + FakeRuntime）', () => {
  beforeEach(() => { stubCliSnapshot(); });

  async function flushConfigure(ms = 20): Promise<void> {
    // 等 fire-and-forget 的 configure 链跑完；cliChanged 路径含 await stop + await start
    await new Promise((r) => setTimeout(r, ms));
  }

  function collectBusEvents(): BusEvent[] {
    const events: BusEvent[] = [];
    eventBus.events$.subscribe((e) => events.push(e));
    return events;
  }

  it('R2-1 切 cliType：立即 ack（早于 spawn resolve），稍后 configured/stopped/started 三连', async () => {
    const runtime = new FakePrimaryRuntime();
    runtime.spawnDelayMs = 80;  // 拉长 start 窗口证明 ack 早于 spawn resolve
    const pa = new PrimaryAgent(eventBus, runtime);
    await pa.configure({ name: 'A', cliType: 'claude' });
    await pa.start();
    const events = collectBusEvents();

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ primaryAgent: pa }));
    const t0 = Date.now();
    ws.emit('message', JSON.stringify({
      op: 'configure_primary_agent', cliType: 'codex', requestId: 'r1',
    }));

    // 立即 ack：不等 spawn
    expect(last(ws)).toEqual({ type: 'ack', requestId: 'r1', ok: true });
    const ackElapsed = Date.now() - t0;
    expect(ackElapsed).toBeLessThan(runtime.spawnDelayMs);

    await flushConfigure(200);
    const types = events.map((e) => e.type);
    expect(types).toContain('primary_agent.configured');
    expect(types).toContain('primary_agent.stopped');
    expect(types).toContain('primary_agent.started');
    expect(pa.getConfig()!.cliType).toBe('codex');
    await pa.stop();
  });

  it('R2-2 cliType 非法（bogus）→ error{internal_error}，老 driver 已 stopped', async () => {
    const runtime = new FakePrimaryRuntime();
    const pa = new PrimaryAgent(eventBus, runtime);
    await pa.configure({ name: 'A', cliType: 'claude' });
    await pa.start();
    const events = collectBusEvents();

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ primaryAgent: pa }));
    ws.emit('message', JSON.stringify({
      op: 'configure_primary_agent', cliType: 'bogus', requestId: 'r2',
    }));
    // 先收到 ack（立即）
    expect(last(ws)).toEqual({ type: 'ack', requestId: 'r2', ok: true });

    await flushConfigure(100);
    // 下行里应该有 error
    const errMsg = allDown(ws).find(
      (m) => (m as { type: string }).type === 'error',
    ) as { type: string; code: string; message: string } | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg!.code).toBe('internal_error');
    expect(errMsg!.message).toMatch(/bogus/);
    expect(errMsg!.message).toMatch(/not available/);

    // 老 driver 已停
    expect(events.some((e) => e.type === 'primary_agent.stopped')).toBe(true);
    // DB 里 cliType 已变 bogus（upsert 不回滚）
    expect(pa.getConfig()!.cliType).toBe('bogus');
  });

  it('R2-3 带 name + systemPrompt → 透传落盘，mcpConfig 未清空', async () => {
    const runtime = new FakePrimaryRuntime();
    const pa = new PrimaryAgent(eventBus, runtime);
    await pa.configure({
      name: 'Orig',
      cliType: 'claude',
      mcpConfig: [{ name: 'mnemo', surface: '*', search: '*' }],
    });

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ primaryAgent: pa }));
    ws.emit('message', JSON.stringify({
      op: 'configure_primary_agent',
      cliType: 'claude',
      name: 'Renamed',
      systemPrompt: 'you are helpful',
      requestId: 'r3',
    }));
    expect(last(ws)).toEqual({ type: 'ack', requestId: 'r3', ok: true });

    await flushConfigure(20);
    const row = pa.getConfig()!;
    expect(row.name).toBe('Renamed');
    expect(row.systemPrompt).toBe('you are helpful');
    expect(row.mcpConfig).toEqual([{ name: 'mnemo', surface: '*', search: '*' }]);
  });

  it('W2-0 配套：primary_agent.configured 事件含 row', async () => {
    const runtime = new FakePrimaryRuntime();
    const pa = new PrimaryAgent(eventBus, runtime);
    const events = collectBusEvents();

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ primaryAgent: pa }));
    ws.emit('message', JSON.stringify({
      op: 'configure_primary_agent', cliType: 'claude', name: 'Zed',
    }));
    await flushConfigure(20);
    const confEv = events.find(
      (e) => e.type === 'primary_agent.configured',
    ) as PrimaryAgentConfiguredEvent | undefined;
    expect(confEv).toBeDefined();
    expect(confEv!.row.name).toBe('Zed');
    expect(confEv!.row.cliType).toBe('claude');
    expect(confEv!.row).toEqual(pa.getConfig()!);
  });
});

describe('ws-handler · 不直接操作 commRegistry（close 清理在 ws-upgrade 那层）', () => {
  it('path 内部无任何 commRegistry 调用改动 registry size', () => {
    const fakeConn = { destroy: () => {}, send: () => {}, isDestroyed: () => false } as never;
    comms.register('user:u1', fakeConn);

    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({ op: 'subscribe', scope: 'team', id: 'team_01' }));
    ws.emit('message', JSON.stringify({ op: 'unsubscribe', scope: 'team', id: 'team_01' }));
    ws.emit('message', JSON.stringify({ op: 'ping' }));

    expect(comms.size).toBe(1);
  });
});

// ---------- get_turns / get_turn_history ----------

function fakeTurn(turnId: string, driverId: string, endTs: string): import('../agent-driver/turn-types.js').Turn {
  return {
    turnId,
    driverId,
    status: 'done',
    userInput: { text: 'hi', ts: '2026-04-25T00:00:00.000Z' },
    blocks: [],
    startTs: '2026-04-25T00:00:00.000Z',
    endTs,
    stopReason: 'end_turn',
  };
}

describe('ws-handler · get_turns', () => {
  it('aggregator 未就位 → active=null / recent=[]，不报错', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ getTurnAggregator: () => null }));
    ws.emit('message', JSON.stringify({
      op: 'get_turns', driverId: 'inst_alice', limit: 10, requestId: 'r_gt1',
    }));
    const down = last(ws) as { type: string; requestId: string; active: unknown; recent: unknown[] };
    expect(down.type).toBe('get_turns_response');
    expect(down.requestId).toBe('r_gt1');
    expect(down.active).toBeNull();
    expect(down.recent).toEqual([]);
  });

  it('aggregator 就位 → 返回 active + recent；limit 透传', () => {
    const active = fakeTurn('t_active', 'd1', '2026-04-25T00:10:00.000Z');
    const r1 = fakeTurn('t_recent1', 'd1', '2026-04-25T00:05:00.000Z');
    let capturedLimit = -1;
    const reader: WsTurnAggregatorReader = {
      getActive: (_id) => (_id === 'd1' ? active : null),
      getRecent: (_id, limit) => {
        capturedLimit = limit;
        return _id === 'd1' ? [r1] : [];
      },
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ getTurnAggregator: () => reader }));
    ws.emit('message', JSON.stringify({
      op: 'get_turns', driverId: 'd1', limit: 3, requestId: 'r_gt2',
    }));
    const down = last(ws) as { type: string; active: unknown; recent: unknown[] };
    expect(down.type).toBe('get_turns_response');
    expect(down.active).toEqual(active);
    expect(down.recent).toEqual([r1]);
    expect(capturedLimit).toBe(3);
  });

  it('limit 缺省 → 默认 10；超过 50 → clamp 到 50', () => {
    const seen: number[] = [];
    const reader: WsTurnAggregatorReader = {
      getActive: () => null,
      getRecent: (_id, limit) => { seen.push(limit); return []; },
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ getTurnAggregator: () => reader }));
    ws.emit('message', JSON.stringify({ op: 'get_turns', driverId: 'd1' }));
    ws.emit('message', JSON.stringify({ op: 'get_turns', driverId: 'd1', limit: 9999 }));
    expect(seen).toEqual([10, 50]);
  });

  it('非法 driverId 空串 → schema invalid', () => {
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps());
    ws.emit('message', JSON.stringify({ op: 'get_turns', driverId: '' }));
    expect(last(ws)).toEqual({ type: 'error', code: 'bad_request', message: 'schema invalid' });
  });
});

describe('ws-handler · get_turn_history', () => {
  it('首页（无游标）→ items + nextCursor；hasMore=true', () => {
    const t1 = fakeTurn('t1', 'd1', '2026-04-25T00:20:00.000Z');
    const t2 = fakeTurn('t2', 'd1', '2026-04-25T00:10:00.000Z');
    let capturedOpts: ListRecentOpts | null = null;
    const listFn = (driverId: string, opts: ListRecentOpts): ListRecentResult => {
      capturedOpts = opts;
      expect(driverId).toBe('d1');
      return { items: [t1, t2], nextCursor: { endTs: t2.endTs!, turnId: 't2' } };
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ listTurnHistory: listFn }));
    ws.emit('message', JSON.stringify({
      op: 'get_turn_history', driverId: 'd1', limit: 2, requestId: 'r_gh1',
    }));
    const down = last(ws) as { type: string; items: unknown[]; hasMore: boolean; nextCursor: unknown };
    expect(down.type).toBe('get_turn_history_response');
    expect(down.items).toHaveLength(2);
    expect(down.hasMore).toBe(true);
    expect(down.nextCursor).toEqual({ endTs: t2.endTs, turnId: 't2' });
    expect(capturedOpts).toEqual({ limit: 2, before: undefined });
  });

  it('尾页（nextCursor=null）→ hasMore=false', () => {
    const listFn = (): ListRecentResult => ({ items: [], nextCursor: null });
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ listTurnHistory: listFn }));
    ws.emit('message', JSON.stringify({
      op: 'get_turn_history', driverId: 'd1', requestId: 'r_gh2',
    }));
    const down = last(ws) as { type: string; hasMore: boolean; nextCursor: unknown };
    expect(down.type).toBe('get_turn_history_response');
    expect(down.hasMore).toBe(false);
    expect(down.nextCursor).toBeNull();
  });

  it('带完整游标 → before 原样透传给 repo', () => {
    let capturedBefore: { endTs: string; turnId: string } | undefined;
    const listFn = (_id: string, opts: ListRecentOpts): ListRecentResult => {
      capturedBefore = opts.before;
      return { items: [], nextCursor: null };
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ listTurnHistory: listFn }));
    ws.emit('message', JSON.stringify({
      op: 'get_turn_history', driverId: 'd1',
      beforeEndTs: '2026-04-25T00:10:00.000Z', beforeTurnId: 't_prev',
    }));
    expect(capturedBefore).toEqual({ endTs: '2026-04-25T00:10:00.000Z', turnId: 't_prev' });
  });

  it('游标缺一方 → 当首页处理（before=undefined）', () => {
    let capturedBefore: { endTs: string; turnId: string } | undefined = { endTs: 'x', turnId: 'x' };
    const listFn = (_id: string, opts: ListRecentOpts): ListRecentResult => {
      capturedBefore = opts.before;
      return { items: [], nextCursor: null };
    };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ listTurnHistory: listFn }));
    ws.emit('message', JSON.stringify({
      op: 'get_turn_history', driverId: 'd1', beforeEndTs: '2026-04-25T00:10:00.000Z',
    }));
    expect(capturedBefore).toBeUndefined();
  });

  it('repo 抛错 → error{internal_error}，连接不断', () => {
    const listFn = (): ListRecentResult => { throw new Error('db fail'); };
    const ws = fakeWs();
    attachWsHandler(ws, ctx, buildDeps({ listTurnHistory: listFn }));
    ws.emit('message', JSON.stringify({
      op: 'get_turn_history', driverId: 'd1', requestId: 'r_gh5',
    }));
    expect(last(ws)).toEqual({ type: 'error', code: 'internal_error', message: 'db fail' });
    // 下一条 ping 仍应工作
    ws.emit('message', JSON.stringify({ op: 'ping' }));
    expect((last(ws) as { type: string }).type).toBe('pong');
  });
});
