// lifecycle.test.ts —— W2-1a 真依赖回归。
// - 不 mock db/bus：:memory: SQLite + 独立 EventBus + 独立 DriverRegistry。
// - 不 mock mcpManager：全局 singleton 走默认路径（模板 availableMcps 空 → 只出 searchTools）。
// - 不起真 spawn：FakeRuntime/FakeRuntimeHandle 合成 ACP initialize/session-new 应答。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';
process.env.HOME = process.env.HOME ?? '/tmp';

import { subscribeMemberDriverLifecycle, type MemberDriverLifecycleSubscription } from './lifecycle.js';
import { EventBus } from '../../events.js';
import { makeBase } from '../../helpers.js';
import { DriverRegistry } from '../../../agent-driver/registry.js';
import { closeDb, getDb } from '../../../db/connection.js';
import { RoleTemplate } from '../../../domain/role-template.js';
import { RoleInstance } from '../../../domain/role-instance.js';
import type {
  ProcessRuntime,
  RuntimeHandle,
  LaunchSpec,
} from '../../../process-runtime/types.js';
import type { BusEvent } from '../../types.js';
import type { Subscription } from 'rxjs';

// ---- FakeRuntime：复用 primary-agent.test.ts 的思路（合成 ACP 应答）。 ----
class FakeRuntimeHandle implements RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid = 77777;
  killCount = 0;
  killed = false;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private readonly autoRespond: boolean;
  constructor(options: { autoRespond?: boolean } = {}) {
    this.autoRespond = options.autoRespond ?? true;
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
          if (!s || !this.autoRespond) continue;
          let msg: { id?: number | string; method?: string };
          try { msg = JSON.parse(s); } catch { continue; }
          if (msg.id === undefined || !msg.method) continue;
          const resp = synthResp(msg.id, msg.method);
          if (resp) this.stdoutController.enqueue(enc.encode(JSON.stringify(resp) + '\n'));
        }
      },
    });
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => { this.stdoutController = c; } });
  }
  async kill(): Promise<void> {
    this.killCount += 1;
    if (this.killed) return;
    this.killed = true;
    try { this.stdoutController.close(); } catch { /* ignore */ }
    if (this.exitCb) this.exitCb(0, null);
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.exitCb) throw new Error('onExit already registered');
    this.exitCb = cb;
  }
}

function synthResp(id: number | string, method: string): Record<string, unknown> | null {
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  if (method === 'session/new') return { jsonrpc: '2.0', id, result: { sessionId: 'sess-fake' } };
  if (method === 'session/prompt') return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
  return { jsonrpc: '2.0', id, result: {} };
}

class FakeRuntime implements ProcessRuntime {
  readonly handles: FakeRuntimeHandle[] = [];
  spawnError: Error | null = null;
  autoRespond = true;
  lastSpec: LaunchSpec | null = null;
  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    this.lastSpec = spec;
    if (this.spawnError) throw this.spawnError;
    const h = new FakeRuntimeHandle({ autoRespond: this.autoRespond });
    this.handles.push(h);
    return h;
  }
  async isAvailable(): Promise<boolean> { return true; }
  async destroy(): Promise<void> { /* noop */ }
}

function resetDb(): void { closeDb(); getDb(); }

function waitFor(bus: EventBus, predicate: (e: BusEvent) => boolean, timeoutMs = 4000): Promise<BusEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sub.unsubscribe(); reject(new Error(`waitFor timeout`)); }, timeoutMs);
    const sub = bus.events$.subscribe((ev) => {
      if (predicate(ev)) { clearTimeout(t); sub.unsubscribe(); resolve(ev); }
    });
  });
}

// lifecycle 的 register / handle.kill 发生在 driver.{started,stopped} emit 之后，
// 所以等事件后还要让微任务队列排空，才能观察到后续副作用。
async function flushLifecycleAfter<T>(p: Promise<T>, settleMs = 30): Promise<T> {
  const v = await p;
  await new Promise((r) => setTimeout(r, settleMs));
  return v;
}

interface Ctx {
  bus: EventBus;
  registry: DriverRegistry;
  runtime: FakeRuntime;
  sub: MemberDriverLifecycleSubscription;
}

function setup(): Ctx {
  const bus = new EventBus();
  const registry = new DriverRegistry();
  const runtime = new FakeRuntime();
  const sub = subscribeMemberDriverLifecycle({ eventBus: bus, registry, runtime, hubUrl: 'http://x', commSock: '/tmp/x.sock' });
  return { bus, registry, runtime, sub };
}

function teardown(ctx: Ctx): void { ctx.sub.unsubscribe(); ctx.bus.destroy(); }

function emitCreated(bus: EventBus, instance: RoleInstance): void {
  bus.emit({
    ...makeBase('instance.created', 'test'),
    instanceId: instance.id,
    templateName: instance.templateName,
    memberName: instance.memberName,
    isLeader: instance.isLeader,
    teamId: instance.teamId,
    task: instance.task,
  });
}

function emitDeleted(bus: EventBus, id: string, isLeader = false): void {
  bus.emit({
    ...makeBase('instance.deleted', 'test'),
    instanceId: id, previousStatus: 'PENDING', force: false, teamId: null, isLeader,
  });
}

describe('member-driver/lifecycle — 基础路径', () => {
  beforeEach(() => resetDb());
  afterEach(() => closeDb());

  it('instance.created 非 leader → spawn + driver.start + registry 注册 + bus 看到 driver.started', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev', persona: 'p' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'Alice', isLeader: false });

    const startedP = waitFor(ctx.bus, (e) => e.type === 'driver.started');
    emitCreated(ctx.bus, inst);
    const ev = (await flushLifecycleAfter(startedP)) as { type: string; driverId: string };

    expect(ev.driverId).toBe(inst.id);
    expect(ctx.runtime.handles).toHaveLength(1);
    expect(ctx.runtime.lastSpec!.runtime).toBe('host');
    expect(ctx.registry.get(inst.id)).toBeDefined();
    teardown(ctx);
  });

  it('instance.created leader → skip（不 spawn，不 register）', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'lead', role: 'leader' });
    const inst = RoleInstance.create({ templateName: 'lead', memberName: 'Boss', isLeader: true });

    emitCreated(ctx.bus, inst);
    // 让队列有机会跑；leader 是同步 return，等一个微任务即可。
    await new Promise((r) => setTimeout(r, 50));

    expect(ctx.runtime.handles).toHaveLength(0);
    expect(ctx.registry.get(inst.id)).toBeUndefined();
    teardown(ctx);
  });

  it('template 不存在 → stderr + return，不 spawn', async () => {
    const ctx = setup();
    // 建实例 + 临时关 FK + 删模板 —— 模拟"事件发出后模板被外部移除"边界场景。
    RoleTemplate.create({ name: 'transient', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'transient', memberName: 'A', isLeader: false });
    getDb().exec('PRAGMA foreign_keys = OFF');
    getDb().prepare(`DELETE FROM role_templates WHERE name = 'transient'`).run();
    getDb().exec('PRAGMA foreign_keys = ON');

    emitCreated(ctx.bus, inst);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.runtime.handles).toHaveLength(0);
    expect(ctx.registry.get(inst.id)).toBeUndefined();
    teardown(ctx);
  });

  it('instance 不存在（created 载荷引用幽灵 id） → skip', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    ctx.bus.emit({
      ...makeBase('instance.created', 'test'),
      instanceId: 'ghost-id', templateName: 'coder', memberName: 'X',
      isLeader: false, teamId: null, task: null,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.runtime.handles).toHaveLength(0);
    teardown(ctx);
  });

  it('driver.start 抛错（runtime 不响应）→ 不 register、handle.kill 被调', async () => {
    const ctx = setup();
    ctx.runtime.autoRespond = false;
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    const errP = waitFor(ctx.bus, (e) => e.type === 'driver.error', 45_000);
    emitCreated(ctx.bus, inst);
    await flushLifecycleAfter(errP, 80);  // driver.error 先 emit，lifecycle catch 后才 kill handle
    expect(ctx.runtime.handles[0].killed).toBe(true);
    expect(ctx.registry.get(inst.id)).toBeUndefined();
    teardown(ctx);
  }, 50_000);

  it('spawn 抛错 → 无 driver 无 register', async () => {
    const ctx = setup();
    ctx.runtime.spawnError = new Error('spawn failed');
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    emitCreated(ctx.bus, inst);
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.runtime.handles).toHaveLength(0);
    expect(ctx.registry.get(inst.id)).toBeUndefined();
    teardown(ctx);
  });
});

describe('member-driver/lifecycle — 停止 / 幂等 / 竞态', () => {
  beforeEach(() => resetDb());
  afterEach(() => closeDb());

  it('instance.deleted → driver.stop + registry.unregister + handle.kill', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    const startedP = waitFor(ctx.bus, (e) => e.type === 'driver.started');
    emitCreated(ctx.bus, inst);
    await flushLifecycleAfter(startedP);
    const handle = ctx.runtime.handles[0];

    const stoppedP = waitFor(ctx.bus, (e) => e.type === 'driver.stopped');
    emitDeleted(ctx.bus, inst.id);
    await flushLifecycleAfter(stoppedP);

    expect(ctx.registry.get(inst.id)).toBeUndefined();
    expect(handle.killCount).toBeGreaterThanOrEqual(1);
    teardown(ctx);
  });

  it('instance.offline_requested → 等价于 deleted 的 teardown', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    const startedP = waitFor(ctx.bus, (e) => e.type === 'driver.started');
    emitCreated(ctx.bus, inst);
    await flushLifecycleAfter(startedP);
    const handle = ctx.runtime.handles[0];

    const stoppedP = waitFor(ctx.bus, (e) => e.type === 'driver.stopped');
    ctx.bus.emit({
      ...makeBase('instance.offline_requested', 'test'),
      instanceId: inst.id, requestedBy: 'leader-x',
    });
    await flushLifecycleAfter(stoppedP);

    expect(ctx.registry.get(inst.id)).toBeUndefined();
    expect(handle.killCount).toBeGreaterThanOrEqual(1);
    teardown(ctx);
  });

  it('instance.deleted 在 未知 id → 幂等 no-op', async () => {
    const ctx = setup();
    emitDeleted(ctx.bus, 'nobody');
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.runtime.handles).toHaveLength(0);
    teardown(ctx);
  });

  it('C3 同一 instanceId 重复 created → 先 teardown 旧 driver 再起新的', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    let startedCount = 0;
    ctx.bus.events$.subscribe((e) => { if (e.type === 'driver.started') startedCount += 1; });

    emitCreated(ctx.bus, inst);
    // 两次 created 都走同一 per-instance 队列；等第二个 started 到达
    emitCreated(ctx.bus, inst);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { sub.unsubscribe(); reject(new Error('two started timeout')); }, 8000);
      const sub = ctx.bus.events$.subscribe(() => {
        if (startedCount >= 2) { clearTimeout(t); sub.unsubscribe(); resolve(); }
      });
    });
    await new Promise((r) => setTimeout(r, 40));  // 等第二次 register 落地

    expect(ctx.runtime.handles).toHaveLength(2);
    expect(ctx.runtime.handles[0].killCount).toBeGreaterThanOrEqual(1);
    expect(ctx.registry.get(inst.id)).toBeDefined();
    teardown(ctx);
  });

  it('subscription.unsubscribe() → 已启动 driver 被 teardown', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    const startedP = waitFor(ctx.bus, (e) => e.type === 'driver.started');
    emitCreated(ctx.bus, inst);
    await flushLifecycleAfter(startedP);
    const handle = ctx.runtime.handles[0];

    ctx.sub.unsubscribe();
    // teardown 是 fire-and-forget，等一会儿让 driver.stop + handle.kill 完成
    await new Promise((r) => setTimeout(r, 80));
    expect(handle.killCount).toBeGreaterThanOrEqual(1);
    ctx.bus.destroy();
  });
});

describe('member-driver/lifecycle — P2-1 queues/entries 不泄漏', () => {
  beforeEach(() => resetDb());
  afterEach(() => closeDb());

  it('stop 结束后 queues 和 entries 都把该 id 清掉', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'coder', memberName: 'A', isLeader: false });

    const startedP = waitFor(ctx.bus, (e) => e.type === 'driver.started');
    emitCreated(ctx.bus, inst);
    await flushLifecycleAfter(startedP);

    // 起来之后队列尾部自清理已经发生（start 的 promise 已 settle）
    // entries 里还在，因为 driver 没停
    expect(ctx.sub.__entryIds()).toContain(inst.id);

    const stoppedP = waitFor(ctx.bus, (e) => e.type === 'driver.stopped');
    emitDeleted(ctx.bus, inst.id);
    await flushLifecycleAfter(stoppedP, 80);

    // stop 完成 → 两个 Map 都要清
    expect(ctx.sub.__entryIds()).not.toContain(inst.id);
    expect(ctx.sub.__queueIds()).not.toContain(inst.id);
    teardown(ctx);
  });

  it('两个 instance 并发，停一个不动另一个的 queue', async () => {
    const ctx = setup();
    RoleTemplate.create({ name: 'coder', role: 'dev' });
    const a = RoleInstance.create({ templateName: 'coder', memberName: 'Alice', isLeader: false });
    const b = RoleInstance.create({ templateName: 'coder', memberName: 'Bob', isLeader: false });

    let startedCount = 0;
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { s.unsubscribe(); reject(new Error('two started timeout')); }, 8000);
      const s = ctx.bus.events$.subscribe((e) => {
        if (e.type === 'driver.started') {
          startedCount += 1;
          if (startedCount >= 2) { clearTimeout(t); s.unsubscribe(); resolve(); }
        }
      });
    });
    emitCreated(ctx.bus, a);
    emitCreated(ctx.bus, b);
    await done;
    await new Promise((r) => setTimeout(r, 40));

    expect(ctx.sub.__entryIds().sort()).toEqual([a.id, b.id].sort());

    // 只停 a，b 的队列不应被动
    const stoppedA = waitFor(ctx.bus, (e) => e.type === 'driver.stopped');
    emitDeleted(ctx.bus, a.id);
    await flushLifecycleAfter(stoppedA, 80);

    expect(ctx.sub.__entryIds()).toEqual([b.id]);
    expect(ctx.sub.__queueIds()).not.toContain(a.id);
    // b 的 driver 还活着；entries 里还有它
    teardown(ctx);
  });
});
