// 主 Agent 启动守卫集成测试。
//
// 目的：把 cliManager → mcpManager → primaryAgent.boot → driver.start → ACP 握手
// 整条启动链串起来，任何改动让主 Agent 起不来，都必须在这里第一时间变红。
//
// 实现原则：不 mock。
//   - 真实 EventBus、真实 :memory: SQLite、真实 mcpManager.boot()、真实 PrimaryAgent。
//   - cliManager 通过内部 snapshot + readyPromise 注入（原测试沿用的写法，避免 spawn which）。
//   - ProcessRuntime 用 FakeRuntime，stdout 自动回 initialize / session/new，不起真 claude/codex。
//   - driverRegistry 用 new DriverRegistry() 注入隔离全局实例，断言时可直接看 map。
//
// 覆盖场景：
//   1) 黄金路径：boot → auto-configure → start → RUNNING + bus 事件 + registry 注册
//   2) CLI 延迟可用：boot 时空，readyPromise resolve 后自动 start
//   3) CLI 不可用：boot 不起、不抛、isRunning=false
//   4) driver.start 失败：status 回 STOPPED、registry 不留驻
//   5) 重复 boot 幂等：只 spawn 一次
//   6) teardown 清理：driverRegistry 空、状态 STOPPED
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { PrimaryAgent } from '../primary-agent/primary-agent.js';
import {
  buildPrimaryPrompt,
  DEFAULT_PRIMARY_MCP_CONFIG,
} from '../primary-agent/defaults.js';
import { upsertConfig, readRow } from '../primary-agent/repo.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';
import { closeDb, getDb } from '../db/connection.js';
import { cliManager } from '../cli-scanner/manager.js';
import { mcpManager } from '../mcp-store/mcp-manager.js';
import { DriverRegistry } from '../agent-driver/registry.js';
import type {
  ProcessRuntime,
  RuntimeHandle,
  LaunchSpec,
} from '../process-runtime/types.js';

type CliSnap = { name: string; available: boolean; path: string; version: string };

function stubCli(available: boolean): void {
  const snap = (cliManager as unknown as { snapshot: Map<string, CliSnap> }).snapshot;
  snap.set('claude', { name: 'claude', available, path: '/fake/claude', version: '0.0.0' });
  snap.set('codex',  { name: 'codex',  available, path: '/fake/codex',  version: '0.0.0' });
}

function clearCli(): void {
  (cliManager as unknown as { snapshot: Map<string, unknown> }).snapshot.clear();
  (cliManager as unknown as { readyPromise: Promise<void> | null }).readyPromise = null;
}

/** 让 refresh/poll 不做真实扫描，保持当前 snapshot 不变 */
function stubRefreshNoop(): () => void {
  const mgr = cliManager as unknown as { poll: () => Promise<void> };
  const orig = mgr.poll;
  mgr.poll = async () => {}; // no-op
  return () => { mgr.poll = orig; };
}

function setControlledReady(): () => void {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  (cliManager as unknown as { readyPromise: Promise<void> | null }).readyPromise = p;
  return resolve;
}

function resetDb(): void { closeDb(); getDb(); }

function collect(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));
  return events;
}

function waitFor(bus: EventBus, match: (e: BusEvent) => boolean, ms = 2000): Promise<BusEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sub.unsubscribe(); reject(new Error(`waitFor ${ms}ms`)); }, ms);
    const sub = bus.events$.subscribe((e) => {
      if (match(e)) { clearTimeout(t); sub.unsubscribe(); resolve(e); }
    });
  });
}

class FakeHandle implements RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid = 42424;
  killCount = 0;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private ctl!: ReadableStreamDefaultController<Uint8Array>;

  constructor() {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let buf = '';
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          let msg: { id?: number | string; method?: string };
          try { msg = JSON.parse(s); } catch { continue; }
          if (msg.id === undefined || !msg.method) continue;
          const resp = synth(msg.id, msg.method);
          if (resp) this.ctl.enqueue(enc.encode(JSON.stringify(resp) + '\n'));
        }
      },
    });
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => { this.ctl = c; } });
  }

  async kill(): Promise<void> {
    this.killCount += 1;
    try { this.ctl.close(); } catch { /* noop */ }
    if (this.exitCb) this.exitCb(0, null);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
}

function synth(id: number | string, method: string): Record<string, unknown> | null {
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  if (method === 'session/new') return { jsonrpc: '2.0', id, result: { sessionId: 'sess-fake' } };
  return { jsonrpc: '2.0', id, result: {} };
}

class FakeRuntime implements ProcessRuntime {
  handles: FakeHandle[] = [];
  spawnError: Error | null = null;
  async spawn(_spec: LaunchSpec): Promise<RuntimeHandle> {
    if (this.spawnError) throw this.spawnError;
    const h = new FakeHandle();
    this.handles.push(h);
    return h;
  }
  async isAvailable(): Promise<boolean> { return true; }
  async destroy(): Promise<void> { /* noop */ }
}

describe('[guard] 主 Agent 启动链集成守卫', () => {
  beforeAll(() => { mcpManager.boot(); });
  afterAll(() => { mcpManager.teardown(); clearCli(); closeDb(); });
  beforeEach(() => { resetDb(); stubCli(true); });
  afterEach(() => { clearCli(); });

  it('[1] 黄金路径：boot → auto-configure → start → RUNNING（driver 注册 + bus 事件）', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const registry = new DriverRegistry();
    const agent = new PrimaryAgent(bus, runtime, registry);

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    expect(agent.isRunning()).toBe(true);
    expect(agent.getConfig()!.status).toBe('RUNNING');
    const config = agent.getConfig()!;
    expect(registry.get(config.id)).toBeDefined();
    expect(runtime.handles).toHaveLength(1);

    await agent.teardown();
  });

  it('[2] CLI 延迟可用：boot 空等 → readyPromise resolve → 自动 start', async () => {
    clearCli();
    const resolveReady = setControlledReady();
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const registry = new DriverRegistry();
    const agent = new PrimaryAgent(bus, runtime, registry);

    agent.boot();
    expect(agent.isRunning()).toBe(false);
    expect(runtime.handles).toHaveLength(0);

    stubCli(true);
    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    resolveReady();
    await startedP;

    expect(agent.isRunning()).toBe(true);
    expect(runtime.handles).toHaveLength(1);
    await agent.teardown();
  });

  it('[3] CLI 不可用：boot 不启动、不抛、无 spawn', async () => {
    clearCli();
    stubCli(false);
    setControlledReady();
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    expect(() => agent.boot()).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(agent.isRunning()).toBe(false);
    expect(runtime.handles).toHaveLength(0);

    await agent.teardown();
  });

  it('[3b] CLI 延迟扫描完成但仍不可用 — 不死循环', async () => {
    // 复现 bug：ready() resolve 后 isAvailable 仍 false → 旧代码无条件 reboot() → 无限循环
    clearCli();
    const resolveReady = setControlledReady();
    const restoreRefresh = stubRefreshNoop(); // 阻止 refresh 做真实扫描
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    // boot 进入 wait-cli
    agent.boot();
    expect(agent.isRunning()).toBe(false);

    // 扫描完成，但 CLI 仍不可用（snapshot 标记 available=false，refresh 也不刷新）
    stubCli(false);
    resolveReady();
    // 让 microtask（ready().then）和宏任务（refresh().then）flush
    await new Promise((r) => setTimeout(r, 50));

    // 不应死循环，应停在 stopped 状态
    expect(agent.isRunning()).toBe(false);
    expect(runtime.handles).toHaveLength(0);

    restoreRefresh();
    await agent.teardown();
  });

  it('[4] driver.start 失败：status 回 STOPPED、registry 不留驻', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const runtime = new FakeRuntime();
    runtime.spawnError = new Error('spawn failed: bin missing');
    const registry = new DriverRegistry();
    const agent = new PrimaryAgent(bus, runtime, registry);

    await agent.configure({ name: 'Guard', cliType: 'claude' });
    await expect(agent.start()).rejects.toThrow(/spawn failed/);

    const row = agent.getConfig()!;
    expect(agent.isRunning()).toBe(false);
    expect(row.status).not.toBe('RUNNING');
    expect(registry.get(row.id)).toBeUndefined();
    expect(events.find((e) => e.type === 'primary_agent.started')).toBeUndefined();
  });

  it('[5] 重复 boot 幂等：driver 已存在时不重复 spawn', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;
    expect(runtime.handles).toHaveLength(1);
    const firstHandle = runtime.handles[0];

    agent.boot();
    agent.boot();
    await new Promise((r) => setTimeout(r, 30));
    expect(runtime.handles).toHaveLength(1);
    expect(runtime.handles[0]).toBe(firstHandle);

    await agent.teardown();
  });

  it('[7] auto-configure 自动填默认 prompt + mcpConfig（只含 mnemo，mteam-primary 由 mcpManager 注入不走模板）', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    const row = agent.getConfig()!;
    expect(row.systemPrompt).toBe(buildPrimaryPrompt('MTEAM'));
    expect(row.systemPrompt.length).toBeGreaterThan(0);
    const mcpNames = row.mcpConfig.map((m) => m.name);
    // 模板里只有 mnemo：mteam-primary 由 resolveForPrimary 无条件注入，
    // 写进模板反而触发 store 查找失败 → skipped 日志。
    expect(mcpNames).not.toContain('mteam-primary');
    expect(mcpNames).toEqual(['mnemo']);
    expect(row.mcpConfig).toEqual(DEFAULT_PRIMARY_MCP_CONFIG);

    await agent.teardown();
  });

  it('[8] 老配置（空 prompt + 旧 serverName schema）boot 自动修正为默认 prompt + mcpConfig', async () => {
    // 模拟历史残留：name=Leader、systemPrompt 空、mcpConfig 旧 serverName schema
    upsertConfig({
      name: 'Leader',
      cliType: 'claude',
      systemPrompt: '',
      // 用真实的旧 schema { serverName, mode } 作为"需要被修正"的证据
      mcpConfig: [{ serverName: 'mteam', mode: 'all' } as unknown as { name: string; surface: '*'; search: '*' }],
    });
    const before = readRow()!;
    expect(before.systemPrompt).toBe('');
    expect(before.name).toBe('Leader');

    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    const after = agent.getConfig()!;
    expect(after.systemPrompt).toBe(buildPrimaryPrompt('Leader'));
    const mcpNames = after.mcpConfig.map((m) => m.name);
    expect(mcpNames).toContain('mnemo');
    expect(mcpNames).not.toContain('mteam-primary');
    // name / cliType 不能被迁移覆盖
    expect(after.name).toBe('Leader');
    expect(after.cliType).toBe('claude');

    await agent.teardown();
  });

  it('[8b] 老配置（prompt 非空但 mcpConfig 是旧 serverName schema）boot 也要修正 mcpConfig', async () => {
    const userPrompt = '# 我的自定义 prompt';
    upsertConfig({
      name: 'Custom',
      cliType: 'claude',
      systemPrompt: userPrompt,
      mcpConfig: [{ serverName: 'mteam', mode: 'all' } as unknown as { name: string; surface: '*'; search: '*' }],
    });

    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    const after = agent.getConfig()!;
    // prompt 非空 → 保留用户自定义
    expect(after.systemPrompt).toBe(userPrompt);
    // mcpConfig 是旧 schema → 替换成默认
    expect(after.mcpConfig).toEqual(DEFAULT_PRIMARY_MCP_CONFIG);

    await agent.teardown();
  });

  it('[10] 空 prompt + 新 schema mcpConfig：只覆写 prompt，mcpConfig 保留原样', async () => {
    // 历史残留的另一种形态：prompt 被清空过，但 mcpConfig 是用户配置的新 schema。
    // maybeMigrateDefaults 只应该补 prompt，不该踩掉用户的 mcpConfig。
    upsertConfig({
      name: 'Test',
      cliType: 'claude',
      systemPrompt: '',
      mcpConfig: [{ name: 'custom-mcp', surface: '*', search: '*' }],
    });

    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    const after = agent.getConfig()!;
    expect(after.systemPrompt).toBe(buildPrimaryPrompt('Test'));
    // mcpConfig 是新 schema → 不迁移，保留用户原样
    expect(after.mcpConfig).toEqual([{ name: 'custom-mcp', surface: '*', search: '*' }]);
    expect(after.name).toBe('Test');
    expect(after.cliType).toBe('claude');

    await agent.teardown();
  });

  it('[9] 已有正确 prompt：boot 不覆盖用户自定义', async () => {
    const userPrompt = '# 我的自定义主 Agent prompt\n只干我指定的事。';
    upsertConfig({
      name: 'Custom',
      cliType: 'claude',
      systemPrompt: userPrompt,
      mcpConfig: [{ name: 'mnemo', surface: '*', search: '*' }],
    });

    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime, new DriverRegistry());

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;

    const after = agent.getConfig()!;
    expect(after.systemPrompt).toBe(userPrompt);
    // mcpConfig 也应保持用户配置原样
    expect(after.mcpConfig.map((m) => m.name)).toEqual(['mnemo']);

    await agent.teardown();
  });

  it('[6] teardown：driverRegistry 清空 + status STOPPED', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const registry = new DriverRegistry();
    const agent = new PrimaryAgent(bus, runtime, registry);

    const startedP = waitFor(bus, (e) => e.type === 'primary_agent.started');
    agent.boot();
    await startedP;
    const id = agent.getConfig()!.id;
    expect(registry.get(id)).toBeDefined();

    await agent.teardown();

    expect(agent.isRunning()).toBe(false);
    expect(registry.get(id)).toBeUndefined();
    expect(agent.getConfig()!.status).toBe('STOPPED');
  });
});
