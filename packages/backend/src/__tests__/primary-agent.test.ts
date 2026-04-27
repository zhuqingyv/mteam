// PrimaryAgent 单测：覆盖 configure / start / stop / driver.error / runtime.exit 5 条主路径。
// 对应 docs/phase-sandbox-acp/stage-2/REGRESSION.md §4.1-4.7。
// 不起真 ACP 子进程：注入 FakeRuntime + FakeRuntimeHandle，后者自动响应 initialize + session/new。
// 不 mock db/bus：真实 :memory: SQLite + new EventBus() 隔离。
// cliManager 用内部 snapshot 注入：CI 若无 claude/codex 也能跑。
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { PrimaryAgent } from '../primary-agent/primary-agent.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent, CliAvailableEvent } from '../bus/types.js';
import { makeBase } from '../bus/helpers.js';
import { closeDb, getDb } from '../db/connection.js';
import { cliManager } from '../cli-scanner/manager.js';
import type {
  ProcessRuntime,
  RuntimeHandle,
  LaunchSpec,
} from '../process-runtime/types.js';

// 让 cliManager.isAvailable('claude'/'codex') 返回 true，避免测试依赖本机 CLI。
// 测试不起真 spawn（交给 FakeRuntime），本字段只影响 start() 的可用性门禁。
function stubCliManager(): void {
  const snap = (cliManager as unknown as { snapshot: Map<string, unknown> }).snapshot;
  snap.set('claude', { name: 'claude', available: true, path: '/fake/claude', version: '0.0.0' });
  snap.set('codex',  { name: 'codex',  available: true, path: '/fake/codex',  version: '0.0.0' });
}

function clearCliManager(): void {
  const snap = (cliManager as unknown as { snapshot: Map<string, unknown> }).snapshot;
  snap.clear();
}

/** 设置一个受控的 readyPromise，返回 resolve 函数供测试手动触发。 */
function setControlledReady(): () => void {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  (cliManager as unknown as { readyPromise: Promise<void> | null }).readyPromise = p;
  return resolve;
}

function clearReadyPromise(): void {
  (cliManager as unknown as { readyPromise: Promise<void> | null }).readyPromise = null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resetDb(): void {
  closeDb();
  getDb();
}

function collectEvents(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));
  return events;
}

// ---- FakeRuntimeHandle: 自动应答 ACP initialize + session/new 的 JSON-RPC stdio mock。----
// driver 用 acp.ndJsonStream(handle.stdin, handle.stdout) 架设 JSON-RPC。
// 我们在 stdin 侧开 transform：收到每行 JSON-RPC request → 合成对应 response 推到 stdout。
class FakeRuntimeHandle implements RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid = 99999;
  killCount = 0;
  killed = false;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private autoRespond: boolean;

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
          if (!s) continue;
          if (!this.autoRespond) continue;
          let msg: { id?: number | string; method?: string; params?: unknown };
          try { msg = JSON.parse(s); } catch { continue; }
          // 只应答 requests（带 id + method）。notifications 忽略。
          if (msg.id === undefined || !msg.method) continue;
          const resp = synthesizeResponse(msg.id, msg.method);
          if (resp) this.stdoutController.enqueue(enc.encode(JSON.stringify(resp) + '\n'));
        }
      },
    });
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => { this.stdoutController = c; },
    });
  }

  async kill(): Promise<void> {
    this.killCount += 1;
    if (this.killed) return;
    this.killed = true;
    try { this.stdoutController.close(); } catch { /* already closed */ }
    if (this.exitCb) this.exitCb(0, null);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.exitCb) throw new Error('onExit already registered');
    this.exitCb = cb;
  }

  simulateExit(code: number | null, signal: string | null): void {
    if (this.killed) return;
    this.killed = true;
    try { this.stdoutController.close(); } catch { /* ignore */ }
    if (this.exitCb) this.exitCb(code, signal);
  }
}

function synthesizeResponse(id: number | string, method: string): Record<string, unknown> | null {
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      },
    };
  }
  if (method === 'session/new') {
    return { jsonrpc: '2.0', id, result: { sessionId: 'sess-fake' } };
  }
  if (method === 'session/prompt') {
    return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
  }
  return { jsonrpc: '2.0', id, result: {} };
}

class FakeRuntime implements ProcessRuntime {
  handles: FakeRuntimeHandle[] = [];
  spawnSpec: LaunchSpec | null = null;
  spawnError: Error | null = null;
  autoRespond = true;

  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    this.spawnSpec = spec;
    if (this.spawnError) throw this.spawnError;
    const h = new FakeRuntimeHandle({ autoRespond: this.autoRespond });
    this.handles.push(h);
    return h;
  }

  async isAvailable(): Promise<boolean> { return true; }
  async destroy(): Promise<void> { /* noop */ }
}

// 等 bus 收到某个 type 的事件，或超时抛错。
function waitFor(bus: EventBus, predicate: (ev: BusEvent) => boolean, timeoutMs = 2000): Promise<BusEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`waitFor timeout ${timeoutMs}ms`));
    }, timeoutMs);
    const sub = bus.events$.subscribe((ev) => {
      if (predicate(ev)) {
        clearTimeout(t);
        sub.unsubscribe();
        resolve(ev);
      }
    });
  });
}

describe('PrimaryAgent.configure', () => {
  beforeEach(() => {
    resetDb();
  });
  afterAll(() => {
    closeDb();
  });

  it('首次 configure：写入一行，id 是 UUID，status=STOPPED', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const agent = new PrimaryAgent(bus, new FakeRuntime());

    const row = await agent.configure({ name: 'Alice', cliType: 'claude' });
    expect(row.id).toMatch(UUID_RE);
    expect(row.name).toBe('Alice');
    expect(row.cliType).toBe('claude');
    expect(row.status).toBe('STOPPED');
    expect(row.systemPrompt).toBe('');
    expect(row.mcpConfig).toEqual([]);

    const count = (getDb().prepare('SELECT COUNT(*) as c FROM primary_agent').get() as { c: number }).c;
    expect(count).toBe(1);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('primary_agent.configured');
    // W2-0：configured 事件含完整 row，与 getConfig() 一致
    const ev = events[0] as { type: string; row: unknown };
    expect(ev.row).toEqual(agent.getConfig()!);
  });

  it('第二次 configure：id 不变，仅字段更新', async () => {
    const bus = new EventBus();
    const agent = new PrimaryAgent(bus, new FakeRuntime());
    const first = await agent.configure({ name: 'A', cliType: 'claude' });
    const second = await agent.configure({ name: 'B', systemPrompt: 'hi' });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('B');
    expect(second.cliType).toBe('claude');
    expect(second.systemPrompt).toBe('hi');

    const count = (getDb().prepare('SELECT COUNT(*) as c FROM primary_agent').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('configure 带 mcpConfig → 持久化', async () => {
    const bus = new EventBus();
    const agent = new PrimaryAgent(bus, new FakeRuntime());
    const mcpConfig = [
      { name: 'mnemo', surface: '*' as const, search: '*' as const },
    ];
    const row = await agent.configure({ name: 'A', cliType: 'claude', mcpConfig });
    expect(row.mcpConfig).toEqual(mcpConfig);
  });
});

describe('PrimaryAgent.getConfig', () => {
  beforeEach(() => {
    resetDb();
  });

  it('未配置 → null', () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    expect(agent.getConfig()).toBeNull();
  });

  it('已配置 → 返回 row 数据', async () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    const created = await agent.configure({ name: 'X', cliType: 'claude' });
    const got = agent.getConfig();
    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect(got!.name).toBe('X');
  });
});

describe('PrimaryAgent.isRunning / start（基础路径）', () => {
  beforeEach(() => {
    resetDb();
  });

  it('初始 isRunning === false', () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    expect(agent.isRunning()).toBe(false);
  });

  it('start 未配置 → 抛错', async () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    await expect(agent.start()).rejects.toThrow(/not configured/);
    expect(agent.isRunning()).toBe(false);
  });

  it('stop 未运行 → 不抛错（幂等）', async () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    await expect(agent.stop()).resolves.toBeUndefined();
  });

  it('configure 后 stop → 不抛错，status 保持 STOPPED', async () => {
    const agent = new PrimaryAgent(new EventBus(), new FakeRuntime());
    await agent.configure({ name: 'A', cliType: 'claude' });
    await expect(agent.stop()).resolves.toBeUndefined();
    expect(agent.getConfig()!.status).toBe('STOPPED');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION §4 — 主路径用例
// ---------------------------------------------------------------------------

describe('REGRESSION §4.1 — start 全流程到 RUNNING', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('runtime.spawn 调用 1 次、spec.runtime=host、driver → RUNNING', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Alpha', cliType: 'claude', systemPrompt: 'hi' });

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    await agent.start();
    await startedP;

    expect(runtime.handles).toHaveLength(1);
    expect(runtime.spawnSpec!.runtime).toBe('host');
    expect(runtime.spawnSpec!.command).toBe(process.execPath);
    expect(agent.isRunning()).toBe(true);
    expect(agent.getConfig()!.status).toBe('RUNNING');

    await agent.stop();
  });
});

describe('REGRESSION §4.2 — runtime.spawn 抛错 → driver 不创建', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('spawn reject 后 isRunning=false、status 未变 RUNNING、无 driver.started', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    runtime.spawnError = new Error('spawn failed: image missing');
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });

    await expect(agent.start()).rejects.toThrow(/spawn failed/);
    expect(agent.isRunning()).toBe(false);
    expect(agent.getConfig()!.status).not.toBe('RUNNING');
    expect(events.find((e) => e.type === 'driver.started')).toBeUndefined();
    expect(events.find((e) => e.type === 'primary_agent.started')).toBeUndefined();
  });
});

describe('REGRESSION §4.3 — driver.start 超时 → handle.kill 被调', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('handshake 无响应 → 30s 超时抛错，kill 被调，isRunning=false', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    runtime.autoRespond = false;  // 让 FakeHandle 静默：initialize 永不收到 response
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });

    await expect(agent.start()).rejects.toThrow(/start timeout/);
    const handle = runtime.handles[0];
    expect(handle).toBeDefined();
    expect(handle.killCount).toBeGreaterThanOrEqual(1);
    expect(agent.isRunning()).toBe(false);
    expect(events.find((e) => e.type === 'primary_agent.started')).toBeUndefined();
    const err = events.find((e) => e.type === 'driver.error');
    expect(err).toBeDefined();
  }, 45_000);
});

describe('REGRESSION §4.4 — stop 同时关 driver 和 handle', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('RUNNING 态 stop 后：driver.stopped + handle.kill + primary_agent.stopped + DB STOPPED', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();

    const handle = runtime.handles[0];
    await agent.stop();

    expect(handle.killCount).toBeGreaterThanOrEqual(1);
    expect(agent.isRunning()).toBe(false);
    expect(events.find((e) => e.type === 'driver.stopped')).toBeDefined();
    expect(events.find((e) => e.type === 'primary_agent.stopped')).toBeDefined();
    expect(agent.getConfig()!.status).toBe('STOPPED');
  });
});

describe('REGRESSION §4.5 — runtime 进程崩溃：give_up 路径（self-heal 上限后）', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('覆盖 selfHeal 直接 give_up：simulateExit 后 primary_agent.stopped，状态 STOPPED', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();
    // W2-3：让 self-heal 立刻 give_up，落到老的 stopped 语义。restart 分支另测。
    agent.selfHeal = {
      policy: {} as never,
      onCrash: () => ({ action: 'give_up', delayMs: 0, attempt: 4 }),
      schedule: () => { throw new Error('should not schedule on give_up'); },
      cancelScheduled: () => undefined,
      reset: () => undefined,
    };

    const handle = runtime.handles[0];
    const stoppedP = waitFor(bus, (e) => e.type === 'primary_agent.stopped');
    handle.simulateExit(137, 'SIGKILL');
    await stoppedP;

    expect(events.find((e) => e.type === 'driver.error')).toBeDefined();
    expect(events.find((e) => e.type === 'driver.stopped')).toBeDefined();
    expect(agent.isRunning()).toBe(false);
    expect(agent.getConfig()!.status).toBe('STOPPED');
  });
});

describe('REGRESSION §4.6 — configure 切换 cliType 触发 stop → start', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('claude RUNNING → configure codex：先 stop 旧的，spawn 新 codex spec', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();
    expect(runtime.handles).toHaveLength(1);

    // 切到 codex：胶水先 stop 旧 driver+handle，再以新 cliType 起
    await agent.configure({ cliType: 'codex' });
    expect(runtime.handles).toHaveLength(2);
    // 旧 handle 已 killed
    expect(runtime.handles[0].killCount).toBeGreaterThanOrEqual(1);
    // 新 spec 的 args 含 codex 包名
    expect(runtime.spawnSpec!.args.some((a) => a.includes('codex-acp'))).toBe(true);
    expect(agent.getConfig()!.cliType).toBe('codex');
    expect(agent.getConfig()!.status).toBe('RUNNING');

    await agent.stop();
  });
});

describe('REGRESSION §4.7 — events$ 被 bus-bridge 正确挂接', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('start 成功后 bus 上能看到 driver.started，driverId === row.id', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    const row = await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();

    const started = events.find((e) => e.type === 'driver.started');
    expect(started).toBeDefined();
    expect((started as { driverId: string }).driverId).toBe(row.id);

    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// W2-3 — primary-agent 自愈（restart 指数退避 / give_up / S4 物理隔离）
// ---------------------------------------------------------------------------

describe('W2-3 §1 — 崩溃走 restart 分支：selfHeal.schedule 被调一次，带正确 delay', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('restart 决策 → schedule(delayMs, run) 被调用，未立即 emit primary_agent.stopped', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();

    const scheduled: Array<{ delayMs: number }> = [];
    agent.selfHeal = {
      policy: {} as never,
      onCrash: () => ({ action: 'restart', delayMs: 1000, attempt: 1 }),
      schedule: (delayMs) => { scheduled.push({ delayMs }); /* 不真的执行 run 避免 start 重入 */ },
      cancelScheduled: () => undefined,
      reset: () => undefined,
    };

    const stoppedBefore = events.filter((e) => e.type === 'primary_agent.stopped').length;
    runtime.handles[0].simulateExit(137, 'SIGKILL');
    // 给 microtask 跑完 onDriverDeath
    await new Promise((r) => setTimeout(r, 10));

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(1000);
    // restart 路径下不 emit primary_agent.stopped
    const stoppedAfter = events.filter((e) => e.type === 'primary_agent.stopped').length;
    expect(stoppedAfter).toBe(stoppedBefore);
  });
});

describe('W2-3 §2 — give_up 路径：emit primary_agent.stopped + 状态 STOPPED', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('selfHeal.give_up 后：primary_agent.stopped 发出、schedule 不被调用', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    const row = await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();

    let scheduleCalled = 0;
    agent.selfHeal = {
      policy: {} as never,
      onCrash: () => ({ action: 'give_up', delayMs: 0, attempt: 4 }),
      schedule: () => { scheduleCalled += 1; },
      cancelScheduled: () => undefined,
      reset: () => undefined,
    };

    const stoppedP = waitFor(bus, (e) => e.type === 'primary_agent.stopped');
    runtime.handles[0].simulateExit(137, 'SIGKILL');
    const ev = await stoppedP;
    expect((ev as { agentId: string }).agentId).toBe(row.id);
    expect(scheduleCalled).toBe(0);
    expect(agent.getConfig()!.status).toBe('STOPPED');
    expect(agent.isRunning()).toBe(false);
  });
});

describe('W2-3 §3 — S4 物理隔离：primary 的 selfHeal 独立于 container 共享 policy', () => {
  it('即便 "共享" policy 在别处已 give_up，primary 自己的 policy 仍可 restart', async () => {
    // 直接测 self-heal 工厂：两个独立实例不共享 map（维护者反悔时的守门）
    const { createSelfHeal } = await import('../primary-agent/self-heal.js');
    const shared = createSelfHeal({ maxRestarts: 3, backoffBaseMs: 1000 });
    // 模拟共享实例 4 次崩溃 → give_up
    for (let i = 0; i < 3; i++) shared.onCrash('agent-1');
    expect(shared.onCrash('agent-1').action).toBe('give_up');

    // primary 独立 self-heal：第一次崩溃仍应 restart
    const primary = createSelfHeal({ maxRestarts: 3, backoffBaseMs: 1000 });
    const d = primary.onCrash('agent-1');
    expect(d.action).toBe('restart');
    expect(d.delayMs).toBe(1000);
    expect(d.attempt).toBe(1);
  });
});

describe('W2-3 §4 — 正常 stop 时 selfHeal.reset 被调用（避免残留计数/挂起 restart）', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('stop() → selfHeal.reset(agentId) 被调一次', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    const row = await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();

    const resetCalls: string[] = [];
    agent.selfHeal = {
      policy: {} as never,
      onCrash: () => ({ action: 'give_up', delayMs: 0, attempt: 1 }),
      schedule: () => undefined,
      cancelScheduled: () => undefined,
      reset: (id) => { resetCalls.push(id); },
    };

    await agent.stop();
    expect(resetCalls).toEqual([row.id]);
  });
});

describe('W2-3 §5 — restart 分支真的延时触发 start：selfHeal 真实实现串起来', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('崩溃后用 fake schedule 立即触发 run → runtime.spawn 被调第二次', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'A', cliType: 'claude' });
    await agent.start();
    expect(runtime.handles).toHaveLength(1);

    agent.selfHeal = {
      policy: {} as never,
      onCrash: () => ({ action: 'restart', delayMs: 0, attempt: 1 }),
      schedule: (_d, run) => { run(); },  // 立即执行避免 fake timer 依赖
      cancelScheduled: () => undefined,
      reset: () => undefined,
    };

    runtime.handles[0].simulateExit(137, 'SIGKILL');
    // 等重启链：onDriverDeath → schedule.run → start → spawn
    await waitFor(bus, (e) => e.type === 'primary_agent.started' && runtime.handles.length === 2);
    expect(runtime.handles).toHaveLength(2);
    expect(agent.isRunning()).toBe(true);

    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// CLI 不可用 → waitForCliScan (ready()) → 扫描完成后自动 boot
// ---------------------------------------------------------------------------

describe('boot 时 CLI 不可用 → ready() 等扫描完成 → 自动 start', () => {
  beforeEach(() => resetDb());
  afterEach(() => clearReadyPromise());

  it('CLI 不可用时 boot 不启动，ready() resolve 后重新 boot 并 start', async () => {
    clearCliManager();
    const resolveReady = setControlledReady();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);

    // boot 时 CLI 不可用，不应 start
    agent.boot();
    expect(agent.isRunning()).toBe(false);
    expect(runtime.handles).toHaveLength(0);

    // 模拟 cliManager 扫描完成：注入 snapshot + resolve ready()
    stubCliManager();
    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    resolveReady();

    await startedP;
    expect(agent.isRunning()).toBe(true);
    expect(runtime.handles).toHaveLength(1);
    expect(agent.getConfig()!.status).toBe('RUNNING');

    await agent.stop();
  });

  it('已配置 row 但 CLI 不可用 → ready() resolve 后自动 start', async () => {
    // 先在 CLI 可用时配置一行
    stubCliManager();
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Alpha', cliType: 'claude' });

    // 清掉 CLI，设置受控 ready，模拟异步扫描未完成
    clearCliManager();
    const resolveReady = setControlledReady();
    agent.boot();
    expect(agent.isRunning()).toBe(false);

    // resolve ready → 重新 boot → start
    stubCliManager();
    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    resolveReady();

    await startedP;
    expect(agent.isRunning()).toBe(true);

    await agent.stop();
  });

  it('teardown 清理订阅，ready() resolve 后不会触发 boot', async () => {
    clearCliManager();
    const resolveReady = setControlledReady();
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);

    agent.boot();
    expect(agent.isRunning()).toBe(false);

    // teardown 清理订阅（cliSub = null）
    await agent.teardown();

    // resolve ready：waitForCliScan 的 .then 检查 this.cliSub 已 null，放弃重入
    stubCliManager();
    resolveReady();

    // 给 microtask 执行的机会
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.isRunning()).toBe(false);
    expect(runtime.handles).toHaveLength(0);
  });

  it('codex 先 available 不会导致无限循环（根因回归）', async () => {
    clearCliManager();
    const resolveReady = setControlledReady();
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);

    agent.boot();
    expect(agent.isRunning()).toBe(false);

    // 模拟：codex 先 emit cli.available（不应触发 boot 重入）
    bus.emit({
      ...makeBase('cli.available', 'cli-scanner'),
      cliName: 'codex',
      path: '/fake/codex',
      version: '0.0.0',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.isRunning()).toBe(false); // 不应因 codex 的事件重入 boot

    // 全量扫描完成：两个 CLI 都可用，resolve ready
    stubCliManager();
    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    resolveReady();

    await startedP;
    expect(agent.isRunning()).toBe(true);
    // 只 spawn 一次，不存在循环
    expect(runtime.handles).toHaveLength(1);

    await agent.stop();
  });
});

describe('boot 时 CLI 已可用 → 直接 start（原有行为不变）', () => {
  beforeAll(stubCliManager);
  beforeEach(() => resetDb());

  it('CLI 可用时 boot 直接 auto-configure 并 start', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    expect(agent.isRunning()).toBe(true);
    expect(runtime.handles).toHaveLength(1);
    expect(agent.getConfig()!.cliType).toBe('claude');

    await agent.stop();
  });

  it('boot 幂等：driver 已存在时重复调用 boot 不创建新 driver', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;
    expect(runtime.handles).toHaveLength(1);

    // 再次 boot，不应创建第二个 driver
    agent.boot();
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.handles).toHaveLength(1);

    await agent.stop();
  });
});
