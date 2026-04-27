// Phase WS · W2-A：comm.* 事件的下行 enrich 工具。
//
// 为 ws-broadcaster.dispatch 提供一个旁路 helper：命中 comm.message_sent /
// comm.message_received 时，按 messageId 反查 MessageStore，在下行 WS payload
// 追加 envelope 字段（summary/content/displayName/kind/replyTo/teamId/readAt/
// attachments），让前端不用二次 HTTP GET /api/messages/:id。
//
// 设计原则（决策 id:550）：
//   - bus 事件 payload **不扩**（id:378 锁死 + id:387 守门测试锁死 WS_EVENT_TYPES.size === 34）
//   - enrich 只发生在 WS 下行层（ws-broadcaster.toWsPayload 之后）
//   - findById 命中失败 → fail-soft，返原 base，前端可走 HTTP 兜底
//
// 抽出独立文件的原因：ws-broadcaster.ts 本体卡 <200 行红线（TASK-LIST W2-A 允许退路）。
// 本文件不进业务胶水职责（只做数据形状映射），归类为非业务模块。

import type { BusEvent } from '../bus/types.js';
import type { MessageStore } from '../comm/message-store.js';

/**
 * 对 comm.message_sent / comm.message_received 事件，按 messageId 反查 MessageStore，
 * 在 WS 下行 payload 追加 envelope 字段。非 comm.* 事件原样返回，findById 命中失败
 * 也原样返回（fail-soft）。
 *
 * 注意：本 helper **必须放在 ws-broadcaster.dispatch 的 client 循环外**（裁决 R-1），
 * 否则每个连接重复一次 SQL，N client → N 次反查，失去性能。
 */
export function enrichCommEnvelope(
  base: Record<string, unknown>,
  event: BusEvent,
  store: MessageStore,
): Record<string, unknown> {
  if (event.type !== 'comm.message_sent' && event.type !== 'comm.message_received') {
    return base;
  }
  const env = store.findById(event.messageId);
  if (!env) return base;
  return {
    ...base,
    envelope: {
      summary: env.summary,
      content: env.content,
      kind: env.kind,
      from: {
        kind: env.from.kind,
        address: env.from.address,
        displayName: env.from.displayName,
        instanceId: env.from.instanceId ?? null,
      },
      to: {
        kind: env.to.kind,
        address: env.to.address,
        displayName: env.to.displayName,
        instanceId: env.to.instanceId ?? null,
      },
      replyTo: env.replyTo,
      teamId: env.teamId,
      readAt: env.readAt,
      attachments: env.attachments,
    },
  };
}
