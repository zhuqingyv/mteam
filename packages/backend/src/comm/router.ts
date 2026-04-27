// CommRouter —— W2-C：吃 MessageEnvelope，同步落库后再路由。
// 三叉：system handler / driver dispatcher / socket；dispatcher 收到的 text 语义是 notifyLine。
// Why 同步 insert：driver.prompt 里带 [msg_id=<id>]，agent 下一轮可能立即 read_message；
//   若落库放到 subscriber 异步做，DB 可能还没入行 → 404（phase-comm TASK-LIST §W2-C）。

import type { CommRegistry } from './registry.js';
import type { MessageEnvelope } from './envelope.js';
import type { MessageStore } from './message-store.js';
import type { EventBus } from '../bus/events.js';
import { parseAddress, serialize } from './protocol.js';
import { formatNotifyLine, envelopeToLegacyMessage } from './router-helpers.js';
import type { SystemHandler } from './types.js';

export type DriverDispatchResult = 'delivered' | 'not-ready' | 'not-found';

// 签名冻结（W2-E / INTERFACE-CONTRACTS.md）；text 在 v2 起语义是 notifyLine。
export type DriverDispatcher = (
  memberInstanceId: string,
  text: string,
) => Promise<DriverDispatchResult>;

export interface RouterDeps {
  registry: CommRegistry;
  /** 同步落库 DAO；测试可注入 spy。 */
  messageStore: MessageStore;
  /** 注入后 emit comm.message_sent/received；不注入则 router 静默。 */
  eventBus?: EventBus;
  driverDispatcher?: DriverDispatcher;
}

export type DispatchOutcome =
  | { route: 'system' }
  | { route: 'local-online'; address: string }
  | { route: 'local-offline'; address: string; stored: boolean }
  | { route: 'remote-unsupported'; scope: string }
  | { route: 'dropped'; reason: string; detail?: string };

export class CommRouter {
  private readonly registry: CommRegistry;
  private readonly store: MessageStore;
  private readonly eventBus?: EventBus;
  private readonly driverDispatcher?: DriverDispatcher;
  private systemHandler: SystemHandler | null = null;

  constructor(deps: RouterDeps) {
    this.registry = deps.registry;
    this.store = deps.messageStore;
    this.eventBus = deps.eventBus;
    this.driverDispatcher = deps.driverDispatcher;
  }

  setSystemHandler(handler: SystemHandler | null): void {
    this.systemHandler = handler;
  }

  async dispatch(env: MessageEnvelope): Promise<DispatchOutcome> {
    let parsed;
    try {
      parsed = parseAddress(env.to.address);
    } catch (e) {
      const reason = (e as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[comm] dropped: ${reason} id=${env.id} to=${env.to.address}`);
      return { route: 'dropped', reason };
    }
    const { scope, id } = parsed;
    if (scope !== 'local') {
      // eslint-disable-next-line no-console
      console.warn(`[comm] remote not implemented: scope=${scope} to=${env.to.address}`);
      return { route: 'remote-unsupported', scope };
    }

    // 成功路径先同步落库。store.insert 幂等（见 message-store U-31）。
    // W2-2：insert 抛错（DB 崩 / FK 违规）收敛为 dropped，不向上传播阻塞调用方。
    try {
      this.store.insert(env);
    } catch (e) {
      const detail = (e as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[comm] dropped: store-failure ${detail} id=${env.id}`);
      return { route: 'dropped', reason: 'store-failure', detail };
    }
    this.emit('sent', env);

    if (id === 'system') {
      if (this.systemHandler) {
        try {
          this.systemHandler(envelopeToLegacyMessage(env));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[comm] system handler error: ${(e as Error).message}`);
        }
      }
      return { route: 'system' };
    }

    if (this.driverDispatcher) {
      try {
        const r = await this.driverDispatcher(id, formatNotifyLine(env));
        if (r === 'delivered') {
          this.emit('received', env, 'driver');
          return { route: 'local-online', address: env.to.address };
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[comm] driverDispatcher threw: ${(e as Error).message}`);
      }
    }

    const conn = this.registry.getConnection(env.to.address);
    if (conn && !conn.destroyed) {
      conn.write(serialize(envelopeToLegacyMessage(env)) + '\n');
      this.emit('received', env, 'socket');
      return { route: 'local-online', address: env.to.address };
    }

    // offline 分支：envelope 已落库，不再调 offline.store；语义上 stored=true。
    return { route: 'local-offline', address: env.to.address, stored: true };
  }

  /**
   * 成员上线回灌未读。走 store.findUnreadFor + formatNotifyLine，
   * 保证与在线消息同一通知行格式（phase-comm W2-F）。
   */
  async replay(address: string): Promise<number> {
    let parsed;
    try {
      parsed = parseAddress(address);
    } catch {
      return 0;
    }
    if (parsed.scope !== 'local' || parsed.id === 'system') return 0;
    const toInstanceId = parsed.id;
    const conn = this.registry.getConnection(address);
    const pending = this.store.findUnreadFor(toInstanceId);

    let delivered = 0;
    for (const env of pending) {
      // write 成功才 markRead：driver 返回 delivered 或 socket write 不抛。失败留未读。
      let ok = false;
      if (this.driverDispatcher) {
        try {
          if ((await this.driverDispatcher(toInstanceId, formatNotifyLine(env))) === 'delivered') {
            ok = true;
          }
        } catch {
          /* swallow，继续试 socket */
        }
      }
      if (!ok && conn && !conn.destroyed) {
        try {
          conn.write(serialize(envelopeToLegacyMessage(env)) + '\n');
          ok = true;
        } catch {
          break;
        }
      }
      if (!ok) continue;
      this.store.markRead(env.id);
      this.emit('received', env, 'replay');
      delivered++;
    }
    return delivered;
  }

  private emit(
    kind: 'sent' | 'received',
    env: MessageEnvelope,
    route?: string,
  ): void {
    if (!this.eventBus) return;
    const base = {
      ts: new Date().toISOString(),
      source: 'comm-router',
      messageId: env.id,
      from: env.from.address,
      to: env.to.address,
    };
    if (kind === 'sent') {
      this.eventBus.emit({ type: 'comm.message_sent', ...base });
    } else {
      this.eventBus.emit({ type: 'comm.message_received', ...base, route: route ?? 'unknown' });
    }
  }
}
