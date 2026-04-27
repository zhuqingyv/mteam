// W2-6 · 通知订阅器（业务胶水）。
//
// 订阅 bus 事件流，对 NOTIFIABLE_EVENT_TYPES 白名单内的事件：
//   1) proxyRouter.route(event, userId) 决策目标
//   2) to.kind='primary_agent' / 'agent' → commRouter.dispatch(system→agent envelope)
//   3) to.kind='user'                    → emit notification.delivered（ws-broadcaster 再按订阅推）
//   4) to.kind='drop'                    → 静默
//
// 时序图 / 竞态 / 错误传播见同目录 NOTIFICATION-README.md。
//
// 约束：本文件不反向 import notification/store 实现；proxyRouter 和 commRouter
// 都由 A3 在 http/server.ts 构造后注入 bootSubscribers。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import type { BusEvent } from '../types.js';
import type { ProxyRouter, ProxyTarget } from '../../notification/proxy-router.js';
import { isNotifiableEventType } from '../../notification/types.js';
import type { CommRouter } from '../../comm/router.js';
import { buildEnvelope } from '../../comm/envelope-builder.js';

export interface NotifSubDeps {
  proxyRouter: ProxyRouter;
  commRouter: CommRouter;
  /** 单用户场景传 'local'；多用户需和 user-session 配合（A3 注入）。 */
  getActiveUserId: () => string | null;
  /** primary_agent 目标解析到具体 instanceId；与 proxyRouter 共用同一份。 */
  getPrimaryAgentInstanceId: () => string | null;
}

export function subscribeNotification(
  deps: NotifSubDeps,
  eventBus: EventBus = defaultBus,
): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.events$.subscribe((event) => {
      if (!isNotifiableEventType(event.type)) return;
      // 守门：自己产生的 notification.delivered 不能再被当通知源触发二次分发，
      // 虽然 NOTIFIABLE_EVENT_TYPES 不含它，这里仍显式拒一刀防白名单漂移。
      if (event.type === 'notification.delivered') return;

      try {
        handle(event, deps, eventBus);
      } catch (err) {
        process.stderr.write(
          `[bus/notification] handler failed for ${event.type}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}

function handle(event: BusEvent, deps: NotifSubDeps, eventBus: EventBus): void {
  const userId = deps.getActiveUserId();
  const target: ProxyTarget = deps.proxyRouter.route(event, userId);

  switch (target.kind) {
    case 'drop':
      return;
    case 'user':
      emitDelivered(eventBus, event, { kind: 'user', id: target.userId });
      return;
    case 'agent':
      dispatchToAgent(deps.commRouter, target.instanceId, event);
      return;
    case 'primary_agent': {
      const primaryId = deps.getPrimaryAgentInstanceId();
      if (!primaryId) {
        // proxyRouter 已做 proxy_all→direct fallback；此处命中意味着
        // custom 规则显式指向 primary_agent 但当下无 primary → 退回 user。
        emitDelivered(eventBus, event, { kind: 'user', id: userId ?? 'local' });
        return;
      }
      dispatchToAgent(deps.commRouter, primaryId, event);
      return;
    }
  }
}

function emitDelivered(
  eventBus: EventBus,
  source: BusEvent,
  target: { kind: 'user' | 'agent'; id: string },
): void {
  // sourceEventId 取 comm.* 的 messageId / 其余走 correlationId / ts+type 兜底。
  // A5 会给所有事件补 eventId 字段；落地前用现有可得 id 做占位。
  const sourceEventId = deriveEventId(source);
  eventBus.emit({
    ...makeBase('notification.delivered', 'bus/notification.subscriber', source.correlationId),
    target,
    sourceEventType: source.type,
    sourceEventId,
  });
}

function dispatchToAgent(router: CommRouter, instanceId: string, event: BusEvent): void {
  const env = buildEnvelope(
    {
      fromKind: 'system',
      fromAddress: 'local:system',
      toAddress: `local:${instanceId}`,
      toLookup: {
        instanceId,
        memberName: instanceId,
        displayName: instanceId,
      },
      summary: `notification: ${event.type}`,
      content: formatEventDigest(event),
      kind: 'system',
    },
    { allowSystemKind: true },
  );
  // fire-and-forget：subscriber 不阻塞 bus 分发链；router 自身有落库和错误吞。
  void Promise.resolve(router.dispatch(env)).catch((err: Error) => {
    process.stderr.write(
      `[bus/notification] commRouter.dispatch rejected for ${event.type}: ${err.message}\n`,
    );
  });
}

// 把事件关键字段 flatten 成一行文本，供 agent 侧 read 记忆 / 上游 UI 渲染。
// 不 JSON.stringify 整个事件（会带 ts/source 噪音）；只挑业务 id-like 字段。
function formatEventDigest(event: BusEvent): string {
  const pick: Record<string, unknown> = { type: event.type };
  const e = event as unknown as Record<string, unknown>;
  for (const k of ['instanceId', 'teamId', 'agentId', 'driverId', 'exitCode', 'signal', 'message', 'reason']) {
    if (e[k] !== undefined) pick[k] = e[k];
  }
  return JSON.stringify(pick);
}

function deriveEventId(event: BusEvent): string {
  const e = event as unknown as Record<string, unknown>;
  if (typeof e.messageId === 'string') return e.messageId;
  if (typeof e.correlationId === 'string') return e.correlationId;
  // 兜底：事件类型 + ts 足以在前端做"是否同一事件"去重。
  return `${event.type}@${event.ts}`;
}
