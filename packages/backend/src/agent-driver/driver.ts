// AgentDriver —— ACP 适配层。生命周期：IDLE→STARTING→READY→WORKING↔READY→STOPPED。
// 进程 spawn/kill 由外部注入的 RuntimeHandle 承担；本类只跑 ACP 握手/session/prompt。
// 事件通过 events$ 暴露；prompt 走三路 race（conn.prompt / 超时 / onExit reject）。
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import type { Observable } from 'rxjs';
import type { RuntimeHandle } from '../process-runtime/types.js';
import type { DriverConfig, DriverStatus, McpServerSpec } from './types.js';
import type { AgentAdapter } from './adapters/adapter.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { DriverEventEmitter, type DriverOutputEvent } from './driver-events.js';

const START_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 120_000;
export class AgentDriver {
  readonly id: string;
  readonly config: DriverConfig;
  readonly events$: Observable<DriverOutputEvent>;
  status: DriverStatus = 'IDLE';
  private readonly handle: RuntimeHandle;
  private readonly adapter: AgentAdapter;
  private readonly emitter = new DriverEventEmitter();
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private pendingPromptReject: ((e: Error) => void) | null = null;

  constructor(id: string, config: DriverConfig, handle: RuntimeHandle, adapter?: AgentAdapter) {
    this.id = id;
    this.config = config;
    this.handle = handle;
    this.adapter = adapter ?? createAdapter(config);
    this.events$ = this.emitter.events$;
    this.handle.onExit((code, signal) => {
      // 先打掉 pending prompt；Q1：prompt catch 不 emit driver.error，统一由此处 emit 一次
      this.pendingPromptReject?.(new Error('process exited during prompt'));
      this.pendingPromptReject = null;
      if (this.status === 'STOPPED') return;
      this.status = 'STOPPED';
      this.emit({ type: 'driver.error', message: `runtime exited (code=${code}, signal=${signal})` });
      this.emit({ type: 'driver.stopped' });
      this.emitter.complete();
    });
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
      this.emit({ type: 'driver.started', pid: this.handle.pid });
    } catch (err) {
      await this.teardown();
      this.status = 'STOPPED';
      this.emit({ type: 'driver.error', message: (err as Error).message });
      throw err;
    }
  }

  async prompt(message: string): Promise<void> {
    if (this.status !== 'READY') throw new Error(`driver ${this.id} not READY`);
    if (!this.conn || !this.sessionId) throw new Error('session missing');
    this.status = 'WORKING';
    const turnId = `turn_${randomUUID()}`;
    this.emit({ type: 'driver.turn_start', turnId, userInput: { text: message, ts: new Date().toISOString() } });
    const timeoutMs = this.config.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      // W2-6：三路 race —— conn.prompt / 超时 / onExit 提前 reject
      const resp = (await Promise.race([
        this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: message }] }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('prompt timeout')), timeoutMs); }),
        new Promise<never>((_, rej) => { this.pendingPromptReject = rej; }),
      ])) as Awaited<ReturnType<acp.ClientSideConnection['prompt']>>;
      this.status = 'READY';
      this.emit({ type: 'driver.turn_done', turnId, stopReason: resp.stopReason });
    } catch (err) {
      // exit 回调是异步调用，TS 这里把 this.status 收窄到 WORKING；运行时可能已被改成 STOPPED
      if ((this.status as DriverStatus) !== 'STOPPED') {
        this.status = 'READY';
        this.emit({ type: 'driver.error', message: (err as Error).message });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingPromptReject = null;
    }
  }

  // ACP session/cancel notification：agent 中止后会以 stopReason='cancelled' resolve 当前 prompt，
  // 触发正常的 turn.completed 路径；本方法不改 status 也不自己 emit。
  async interrupt(): Promise<void> {
    if (this.status !== 'WORKING') return;
    if (!this.conn || !this.sessionId) return;
    await this.conn.cancel({ sessionId: this.sessionId });
  }

  async stop(): Promise<void> {
    if (this.status === 'STOPPED') return;
    await this.teardown();
    this.status = 'STOPPED';
    this.emit({ type: 'driver.stopped' });
    this.emitter.complete();
  }

  private async bringUp(): Promise<void> {
    const stream = acp.ndJsonStream(this.handle.stdin, this.handle.stdout);
    const autoApprove = this.config.autoApprove === true;
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        const ev = this.adapter.parseUpdate(params.update);
        if (ev) this.emit(ev);
      },
      // autoApprove=true：选 options[0] 返回 selected。team-lead 调研：ACP agent 端约定 options[0]
      // 固定是 allow_* 类，按第一个选就等价于"用户点了允许"。
      // ACP 协议 outcome 只有 cancelled | selected 两种合法值 —— 没有 'approved'。
      requestPermission: async (params) => {
        if (!autoApprove) return { outcome: { outcome: 'cancelled' } };
        const first = params.options[0];
        if (!first) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: first.optionId } };
      },
    };
    this.conn = new acp.ClientSideConnection(() => client, stream);
    await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const res = await this.conn.newSession({
      cwd: this.config.cwd,
      mcpServers: toAcpMcpServers(this.config.mcpServers),
      ...(this.adapter.sessionParams(this.config) as object),
    });
    this.sessionId = res.sessionId;
  }

  private async teardown(): Promise<void> {
    try { this.adapter.cleanup(); } catch { /* ignore */ }
    this.sessionId = null;
    this.conn = null;
  }

  private emit(ev: DriverOutputEvent): void {
    this.emitter.emit(ev);
  }
}

export function createAdapter(config: DriverConfig): AgentAdapter {
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
    const headers = Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value }));
    if (s.transport === 'http') return { name: s.name, type: 'http', url: s.url ?? '', headers } as acp.McpServer;
    if (s.transport === 'sse') return { name: s.name, type: 'sse', url: s.url ?? '', headers } as acp.McpServer;
    const env = Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value }));
    return { name: s.name, command: s.command ?? '', args: s.args ?? [], env } as acp.McpServer;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
}
