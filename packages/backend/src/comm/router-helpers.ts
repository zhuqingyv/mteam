// router 辅助：纯拼装/格式化函数。router.ts 受 ≤ 200 行硬约束，把
// notifyLine 拼接 + envelope→legacy Message 转换抽出来后 router 专注
// "路由三叉 + 同步落库 + emit" 三件事。

import type { MessageEnvelope } from './envelope.js';
import type { Message, Address } from './types.js';

/**
 * agent driver 看到的通知行：`@<displayName>><summary>  [msg_id=<id>]`
 * summary 与 [msg_id] 之间两个空格（对齐 comm-model-design.md §3.4）。
 * 此处重复实现、不 import member-agent，避免 router 反向依赖展示层。
 */
export function formatNotifyLine(env: MessageEnvelope): string {
  return `@${env.from.displayName}>${env.summary}  [msg_id=${env.id}]`;
}

/**
 * socket 线协议仍走老 Message 格式（CommClient 按 Message 解码）。
 * 从 envelope 反序一份 Message 给 socket.write 用；不暴露业务字段含义外的内容。
 */
export function envelopeToLegacyMessage(env: MessageEnvelope): Message {
  return {
    type: 'message',
    id: env.id,
    from: env.from.address as Address,
    to: env.to.address as Address,
    payload: {
      summary: env.summary,
      content: env.content ?? '',
      kind: env.kind,
      replyTo: env.replyTo,
      fromDisplayName: env.from.displayName,
    },
    ts: env.ts,
  };
}
