// AgentDriver —— 上层对"一个正在运行的 ACP agent"的统一抽象。
// 生命周期：IDLE → STARTING → READY → WORKING ↔ READY → STOPPED。
// 内部用 ACP SDK 的 ClientSideConnection + ndJsonStream 与子进程 JSON-RPC 通信。
// 所有输出通过 bus 事件发射，消费方按 driverId 订阅。
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { DriverConfig, DriverStatus, McpServerSpec } from './types.js';
import type { AgentAdapter } from './adapters/adapter.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { emitToBus, type DriverBusEvent } from './bus-bridge.js';

// 子进程最长握手时间（ms）。超时 → 视为启动失败。
const START_TIMEOUT_MS = 30_000;

export class AgentDriver {
  readonly id: string;
  readonly config: DriverConfig;
  status: DriverStatus = 'IDLE';

  private adapter: AgentAdapter;
  private child: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;

  constructor(id: string, config: DriverConfig) {
    this.id = id;
    this.config = config;
    this.adapter = createAdapter(config);
  }

  isReady(): boolean {
    return this.status === 'READY';
  }

  async start(): Promise<void> {
    if (this.status !== 'IDLE') throw new Error(`driver ${this.id} not in IDLE`);
    this.status = 'STARTING';
    try {
      await withTimeout(this.bringUp(), START_TIMEOUT_MS, 'start timeout');
      this.status = 'READY';
      this.dispatch({ type: 'driver.started' });
    } catch (err) {
      await this.teardown();
      this.status = 'STOPPED';
      this.dispatch({ type: 'driver.error', message: (err as Error).message });
      throw err;
    }
  }

  async prompt(message: string): Promise<void> {
    if (this.status !== 'READY') throw new Error(`driver ${this.id} not READY`);
    if (!this.conn || !this.sessionId) throw new Error('session missing');
    this.status = 'WORKING';
    try {
      const resp = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: message }],
      });
      this.status = 'READY';
      this.dispatch({ type: 'driver.turn_done', stopReason: resp.stopReason });
    } catch (err) {
      this.status = 'READY';
      this.dispatch({ type: 'driver.error', message: (err as Error).message });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'STOPPED') return;
    await this.teardown();
    this.status = 'STOPPED';
    this.dispatch({ type: 'driver.stopped' });
  }

  // --- private ---

  private async bringUp(): Promise<void> {
    const spec = this.adapter.prepareSpawn(this.config);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.status === 'STOPPED') return;
      this.status = 'STOPPED';
      this.dispatch({
        type: 'driver.error',
        message: `child exited (code=${code}, signal=${signal})`,
      });
    });

    const input = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const self = this;
    const client: acp.Client = {
      async sessionUpdate(params) {
        const ev = self.adapter.parseUpdate(params.update);
        if (ev) self.dispatch(ev);
      },
      async requestPermission() {
        return { outcome: { outcome: 'cancelled' } };
      },
    };
    this.conn = new acp.ClientSideConnection(() => client, stream);

    await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    const extra = this.adapter.sessionParams(this.config);
    const res = await this.conn.newSession({
      cwd: this.config.cwd,
      mcpServers: toAcpMcpServers(this.config.mcpServers),
      ...(extra as object),
    });
    this.sessionId = res.sessionId;
  }

  private async teardown(): Promise<void> {
    try { this.adapter.cleanup(); } catch { /* ignore */ }
    this.sessionId = null;
    this.conn = null;
    const c = this.child;
    this.child = null;
    if (c && !c.killed) {
      c.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(); }, 2000);
        c.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }

  private dispatch(ev: DriverBusEvent): void {
    emitToBus(this.id, ev);
  }
}

function createAdapter(config: DriverConfig): AgentAdapter {
  switch (config.agentType) {
    case 'claude': return new ClaudeAdapter();
    case 'codex':  return new CodexAdapter();
    case 'qwen':   throw new Error('qwen adapter not implemented');
    default: {
      const t: never = config.agentType;
      throw new Error(`unknown agentType: ${String(t)}`);
    }
  }
}

function toAcpMcpServers(specs: McpServerSpec[]): acp.McpServer[] {
  return specs.map((s): acp.McpServer => {
    if (s.transport === 'http') {
      return {
        name: s.name,
        type: 'http',
        url: s.url ?? '',
        headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
      } as acp.McpServer;
    }
    if (s.transport === 'sse') {
      return {
        name: s.name,
        type: 'sse',
        url: s.url ?? '',
        headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
      } as acp.McpServer;
    }
    return {
      name: s.name,
      command: s.command ?? '',
      args: s.args ?? [],
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    } as acp.McpServer;
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}
