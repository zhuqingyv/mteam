// W2-8 · Codex 临时文件纳管 —— 四路径覆盖。
// 胶水层（primary-agent）在 spawn 成功后把 adapter.listTempFiles() 交给 ProcessManager；
// spawn 失败由 adapter.cleanup() 兜底；正常/异常退出走 ProcessManager.unregister 的 unlink。
//
// 路径：
//   1) spawn 失败 → adapter.cleanup() 删临时文件
//   2) spawn 成功 → 正常 stop → onExit 触发 unregister → tempFile 被 unlink
//   3) spawn 成功 → 异常退出（simulateExit 非零 code）→ 同路径 unlink
//   4) spawn 成功 → listTempFiles 返回值被 attachTempFiles 采纳（pid 注册后可查到 tempFiles）
//
// 不起真 ACP 子进程：FakeRuntime 模仿 HostRuntime 的 processManager.register/unregister 契约。
// 不 mock fs：真实落盘/读盘验证 unlink 行为。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { PrimaryAgent } from '../primary-agent/primary-agent.js';
import { EventBus } from '../bus/events.js';
import { closeDb, getDb } from '../db/connection.js';
import { cliManager } from '../cli-scanner/manager.js';
import { processManager } from '../process-manager/index.js';
import type {
  ProcessRuntime,
  RuntimeHandle,
  LaunchSpec,
} from '../process-runtime/types.js';

function stubCliManager(): void {
  const snap = (cliManager as unknown as { snapshot: Map<string, unknown> }).snapshot;
  snap.set('claude', { name: 'claude', available: true, path: '/fake/claude', version: '0.0.0' });
  snap.set('codex',  { name: 'codex',  available: true, path: '/fake/codex',  version: '0.0.0' });
}

function resetDb(): void { closeDb(); getDb(); }

// 模仿 HostRuntime 的 register/unregister 契约：spawn 时登记，exit 时解注册。
// kill() 触发 exit，驱动 unregister 连锁 unlink（ProcessManager 行为）。
class FakeRuntimeHandle implements RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid: number;
  killed = false;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  constructor(pid: number) {
    this.pid = pid;
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
  async kill(): Promise<void> { this.simulateExit(0, null); }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.exitCb) throw new Error('onExit already registered');
    this.exitCb = cb;
  }
  simulateExit(code: number | null, signal: string | null): void {
    if (this.killed) return;
    this.killed = true;
    try { this.stdoutController.close(); } catch { /* ignore */ }
    try { processManager.unregister(this.pid); } catch { /* ignore */ }
    if (this.exitCb) this.exitCb(code, signal);
  }
}

function synthResp(id: number | string, method: string): Record<string, unknown> | null {
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  if (method === 'session/new') return { jsonrpc: '2.0', id, result: { sessionId: 'sess-fake' } };
  if (method === 'session/prompt') return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
  return { jsonrpc: '2.0', id, result: {} };
}

class FakeRuntime implements ProcessRuntime {
  handles: FakeRuntimeHandle[] = [];
  spawnError: Error | null = null;
  private nextPid = 900001;
  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    if (this.spawnError) throw this.spawnError;
    const pid = this.nextPid++;
    const h = new FakeRuntimeHandle(pid);
    this.handles.push(h);
    // 模仿 host-runtime.ts:102 的强制 register。
    processManager.register({
      id: String(pid),
      pid,
      owner: spec.env.TEAM_HUB_PROCESS_OWNER ?? 'runtime',
      kill: (sig) => h.kill(),
    });
    return h;
  }
  async isAvailable(): Promise<boolean> { return true; }
  async destroy(): Promise<void> { /* noop */ }
}

function extractPromptFilePath(spec: LaunchSpec | null): string {
  if (!spec) throw new Error('spec missing');
  const i = spec.args.indexOf('-c');
  expect(i).toBeGreaterThanOrEqual(0);
  const kv = spec.args[i + 1]!;
  expect(kv).toMatch(/^model_instructions_file=/);
  return kv.slice('model_instructions_file='.length);
}

describe('W2-8 · Codex 临时文件纳管 —— 四路径', () => {
  beforeEach(() => {
    resetDb();
    stubCliManager();
  });
  afterAll(() => { closeDb(); });

  it('路径 1 · spawn 失败 → adapter.cleanup() 删临时文件', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    runtime.spawnError = new Error('boom');
    // 拦截 spawn 以捕获 spec（含 prompt 文件路径），然后再抛错。
    let capturedSpec: LaunchSpec | null = null;
    const origSpawn = runtime.spawn.bind(runtime);
    runtime.spawn = async (spec: LaunchSpec) => { capturedSpec = spec; return origSpawn(spec); };

    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Coder', cliType: 'codex', systemPrompt: 'codex sys prompt' });

    await expect(agent.start()).rejects.toThrow('boom');

    const promptPath = extractPromptFilePath(capturedSpec);
    expect(promptPath).toMatch(/mteam-codex-prompt-/);
    expect(existsSync(promptPath)).toBe(false); // adapter.cleanup() 兜底已删除
  });

  it('路径 2 · spawn 成功 → 正常 stop → ProcessManager unregister → tempFile unlink', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Coder', cliType: 'codex', systemPrompt: 'codex normal' });

    await agent.start();
    const handle = runtime.handles[0]!;
    const managed = processManager.get(handle.pid);
    expect(managed).toBeDefined();
    expect(managed!.tempFiles).toHaveLength(1);
    const promptPath = managed!.tempFiles[0]!;
    expect(existsSync(promptPath)).toBe(true);

    await agent.stop(); // driver.stop → handle.kill → simulateExit → unregister → unlink
    await new Promise((r) => setTimeout(r, 50)); // 等 unlink 的 void promise 结算
    expect(existsSync(promptPath)).toBe(false);
  });

  it('路径 3 · spawn 成功 → 异常退出（crash 模拟）→ ProcessManager 统一 unlink', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Coder', cliType: 'codex', systemPrompt: 'codex crash' });

    await agent.start();
    const handle = runtime.handles[0]!;
    const managed = processManager.get(handle.pid);
    expect(managed).toBeDefined();
    const promptPath = managed!.tempFiles[0]!;
    expect(existsSync(promptPath)).toBe(true);

    // 模拟进程崩溃：非 0 退出码，不走 stop 路径
    handle.simulateExit(137, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(promptPath)).toBe(false);
    expect(processManager.get(handle.pid)).toBeUndefined();
  });

  it('路径 4 · attachTempFiles 采纳 adapter.listTempFiles —— pid 注册后可查到 tempFiles', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Coder', cliType: 'codex', systemPrompt: 'codex attach verify' });

    await agent.start();
    const handle = runtime.handles[0]!;
    const managed = processManager.get(handle.pid);
    expect(managed).toBeDefined();
    expect(managed!.tempFiles).toHaveLength(1);
    expect(managed!.tempFiles[0]).toMatch(/mteam-codex-prompt-/);

    await agent.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('Claude adapter listTempFiles 始终空 —— pid 注册后 tempFiles 为空', async () => {
    const bus = new EventBus();
    const runtime = new FakeRuntime();
    const agent = new PrimaryAgent(bus, runtime);
    await agent.configure({ name: 'Hermes', cliType: 'claude', systemPrompt: 'anything' });

    await agent.start();
    const handle = runtime.handles[0]!;
    const managed = processManager.get(handle.pid);
    expect(managed).toBeDefined();
    expect(managed!.tempFiles).toEqual([]); // Claude 不落盘

    await agent.stop();
  });
});
