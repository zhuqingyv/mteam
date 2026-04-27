// Phase WS · W2-2：按订阅过滤的 WebSocket 广播器。
//
// 用于替代 bus/subscribers/ws.subscriber.ts 的全量广播。把 bus.events$ 里的
// 白名单事件，按 per-connection 订阅（SubscriptionManager.match）+ 可见性过滤
// （VisibilityFilter.canSee）两道门，封装成 WsEventDown 下行协议推给对应连接。
//
// 业务胶水职责：
//   1. 订阅 bus.events$ 并用 WS_EVENT_TYPES 过滤（白名单仍保留，防止内部事件泄漏）
//   2. 对每条 event 计算一次下行 id（comm.* 用 messageId；其他读 event.eventId；
//      都没有时生成一次性 UUID 兜底，A 系列接入 makeBase 后变单一路径）
//   3. 对每个 client：match 短路 → canSee 短路 → 包 WsEventDown → ws.send
//   4. send 异常吞掉（连接自己会在 close/error 事件里被摘），不影响其他 client
//
// 与旧 ws.subscriber 的关系（TASK-LIST §534-537）：
//   - WS_EVENT_TYPES 白名单在 ws/event-types.ts（W1-8 从 bus/subscribers/ws.subscriber.ts 提出）
//   - bus/subscribers/ws.subscriber.ts 已改为 re-export，W2-H 守门测试继续跑
//   - 本模块 import 该白名单，不重复定义
//   - 旧模块的 WsBroadcaster.start() 在 A 系列接线时被禁用 / W2-5 删除
//
// 非业务清单：ws/protocol.ts（import type）、ws/subscription-manager.ts、
// filter/visibility-filter.ts（type）、bus/events.ts、bus/types.ts。

import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { WS_EVENT_TYPES } from './event-types.js';
import { enrichCommEnvelope } from './enrich-comm.js';
import type { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';
import type { MessageStore } from '../comm/message-store.js';
import type { ActorPrincipal } from '../filter/types.js';
import type { VisibilityFilter } from '../filter/visibility-filter.js';
import type { SubscriptionManager } from './subscription-manager.js';
import type { WsDownstream, WsEventDown } from './protocol.js';

/**
 * 浏览器风格的 WebSocket 子集。Bun 全局 WebSocket / ws npm 包 / 假 EventEmitter
 * 都结构化兼容，不把广播器耦合到具体 ws 实现。
 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
}

/** WS_OPEN: 与 browser / ws 包一致的 readyState 常量。 */
const WS_OPEN = 1;

/**
 * 每条连接的最小上下文。principal 由 ws-handler（W2-1）根据认证 userId 构造，
 * 广播器拿来喂 VisibilityFilter。本 interface 故意收窄到 broadcaster 实际用到的字段，
 * 让未来 ws-handler.ts 里的 ConnectionContext 结构化兼容无痛喂进来。
 */
export interface BroadcasterConn {
  readonly principal: ActorPrincipal;
}

interface Client {
  ws: WsLike;
  ctx: BroadcasterConn;
}

export interface WsBroadcasterDeps {
  eventBus: EventBus;
  subscriptionManager: SubscriptionManager;
  visibilityFilter: VisibilityFilter;
  /**
   * W2-A：用于 comm.* 下行 enrich envelope（summary/content/displayName…）。
   * 反查失败（findById 返 null）fail-soft 跳过，不扩字段，不抛。
   */
  messageStore: MessageStore;
}

export class WsBroadcaster {
  private readonly clients = new Map<string, Client>();
  private sub: Subscription | null = null;

  constructor(private readonly deps: WsBroadcasterDeps) {}

  /**
   * 注册一个已完成握手的连接。connectionId 必须与 subscriptionManager.addConn
   * 使用的是同一个值（由 ws-handler 负责对齐）。
   */
  addClient(connectionId: string, ws: WsLike, ctx: BroadcasterConn): void {
    this.clients.set(connectionId, { ws, ctx });
  }

  /**
   * 连接断开时调用。清理 subscriptionManager 中的订阅由 ws-handler 负责，
   * 本模块只负责从分发表里摘掉。
   */
  removeClient(connectionId: string): void {
    this.clients.delete(connectionId);
  }

  /** 开始订阅 bus 事件。幂等，重复 start 不重复订阅。 */
  start(): void {
    if (this.sub) return;
    this.sub = this.deps.eventBus.events$
      .pipe(filter((e) => WS_EVENT_TYPES.has(e.type)))
      .subscribe((event) => this.dispatch(event));
  }

  /** 取消订阅 bus 事件；保留已注册 client（方便测试重启），如需全清请显式 removeClient。 */
  stop(): void {
    this.sub?.unsubscribe();
    this.sub = null;
  }

  private dispatch(event: BusEvent): void {
    // 对同一条事件、不同连接推送相同的下行 id：前端按 id 去重才有意义。
    const id = extractEventId(event);
    // 裁决 R-1：enrichCommEnvelope 放循环外。同一条事件只反查 store 一次，
    // 循环内所有 client 共用同一个 payload object，零拷贝零额外 SQL。
    const payload = enrichCommEnvelope(toWsPayload(event), event, this.deps.messageStore);
    for (const [connectionId, client] of this.clients) {
      if (client.ws.readyState !== WS_OPEN) continue;
      if (!this.deps.subscriptionManager.match(connectionId, event)) continue;
      if (!this.deps.visibilityFilter.canSee(client.ctx.principal, event)) continue;
      const down: WsEventDown = { type: 'event', id, event: payload };
      sendSafe(client.ws, down);
    }
  }
}

/**
 * 从 BusEvent 计算下行 id。优先级：
 *   1. comm.* → messageId（与 messages.id 一致，前端按它去重）
 *   2. 任意事件带 eventId 字段（A 系列将 makeBase 改造后即走这条）
 *   3. 兜底：随机 UUID（仅当上游还没迁到 eventId；仅本次分发内 client 间一致）
 */
function extractEventId(event: BusEvent): string {
  if (event.type === 'comm.message_sent' || event.type === 'comm.message_received') {
    return event.messageId;
  }
  const maybe = (event as { eventId?: unknown }).eventId;
  if (typeof maybe === 'string' && maybe.length > 0) return maybe;
  return randomUUID();
}

/**
 * 把 BusEvent 剥 source/correlationId（内部字段，不暴露给前端）后作为 WS 下行
 * event 字段。保留 type/ts 和业务 payload。
 */
export function toWsPayload(event: BusEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'source' || k === 'correlationId') continue;
    out[k] = v;
  }
  return out;
}

/**
 * 序列化并发送，任意异常写 stderr 吞掉。业务语义：
 * 单个连接写失败不能影响其他连接，也不能把 subscriber 的 observer 带崩。
 */
function sendSafe(ws: WsLike, down: WsDownstream): void {
  let json: string;
  try {
    json = JSON.stringify(down);
  } catch (err) {
    process.stderr.write(
      `[ws-broadcaster] serialize failed for type=${down.type}: ${(err as Error).message}\n`,
    );
    return;
  }
  try {
    ws.send(json);
  } catch (err) {
    process.stderr.write(
      `[ws-broadcaster] send failed: ${(err as Error).message}\n`,
    );
  }
}
