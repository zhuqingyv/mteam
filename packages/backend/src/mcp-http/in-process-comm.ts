// 同进程 CommLike 实现：绕过 unix socket，直接把 mteam 工具发出的消息丢进 CommRouter。
// 用于 mcp-http listener 里的 mteam session —— listener 与 CommRouter 在同一进程，
// 不需要 socket 往返。语义上等价于 CommClient.send（最终都会走 router.dispatch）。
import type { CommRouter } from '../comm/router.js';
import type { CommLike } from '../mcp/comm-like.js';
import type { Address } from '../comm/types.js';
import { buildEnvelope, type AgentLookup } from '../comm/envelope-builder.js';
import { lookupAgentByInstanceId as defaultLookupAgent } from '../comm/agent-lookup.js';

export interface InProcessCommOptions {
  router: CommRouter;
  selfAddress: string; // `local:<instanceId>`
  /** 可注入 stub；默认查 primary_agent / role_instances 拿真 displayName。 */
  lookupAgent?: (instanceId: string) => AgentLookup | null;
}

function asAddress(s: string): Address {
  if (s.indexOf(':') <= 0) throw new Error(`invalid address: ${s}`);
  return s as Address;
}

const LOCAL = 'local:';
const stripLocal = (a: string): string => (a.startsWith(LOCAL) ? a.slice(LOCAL.length) : a);

export class InProcessComm implements CommLike {
  private readonly router: CommRouter;
  private readonly selfAddress: Address;
  private readonly lookupAgent: (instanceId: string) => AgentLookup | null;

  constructor(opts: InProcessCommOptions) {
    this.router = opts.router;
    this.selfAddress = asAddress(opts.selfAddress);
    this.lookupAgent = opts.lookupAgent ?? defaultLookupAgent;
  }

  // 同进程无需 registration / ack —— 永远 ready。
  async ensureReady(): Promise<void> {
    return;
  }

  async send(opts: { to: string; payload: Record<string, unknown> }): Promise<void> {
    const toAddress = asAddress(opts.to);
    const fromId = stripLocal(this.selfAddress);
    const toId = stripLocal(toAddress);
    const p = opts.payload;
    // fail-soft：lookup 查不到（启动期 / 未入库）就用 instanceId 兜底三字段。
    const fromLookup = this.lookupAgent(fromId)
      ?? { instanceId: fromId, memberName: fromId, displayName: fromId };
    const env = buildEnvelope({
      fromKind: 'agent',
      fromAddress: this.selfAddress,
      fromLookup,
      toAddress,
      toLookup: toAddress.startsWith(LOCAL)
        ? { instanceId: toId, memberName: toId, displayName: toId }
        : null,
      summary: typeof p.summary === 'string' ? p.summary : '',
      content: typeof p.content === 'string' ? p.content : undefined,
      kind: (p.kind as 'chat' | 'task' | 'broadcast' | undefined) ?? 'chat',
      replyTo: typeof p.replyTo === 'string' ? p.replyTo : null,
    });
    const out = await this.router.dispatch(env);
    if (out.route === 'dropped') throw new Error(`comm dropped: ${out.reason}`);
    if (out.route === 'remote-unsupported') {
      throw new Error(`comm remote scope unsupported: ${out.scope}`);
    }
  }

  // 无底层资源需清理。
  close(): void {
    return;
  }
}
