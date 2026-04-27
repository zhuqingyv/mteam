// socket→envelope 适配器（W2-K）。
// socket 线协议仍是 legacy Message：CommClient 自己拼 {from,to,payload}。
// server.ts 在 router.dispatch 前把它翻译成 MessageEnvelope，强注入 fromKind='agent'。
import type { Message } from './types.js';
import type { MessageEnvelope } from './envelope.js';
import { buildEnvelope } from './envelope-builder.js';

const LOCAL = 'local:';

function stripLocal(addr: string): string {
  return addr.startsWith(LOCAL) ? addr.slice(LOCAL.length) : addr;
}

export function socketMessageToEnvelope(msg: Message): MessageEnvelope {
  const fromId = stripLocal(msg.from);
  const summary = typeof msg.payload.summary === 'string' ? msg.payload.summary : '';
  const content = typeof msg.payload.content === 'string' ? msg.payload.content : undefined;
  const kind = (msg.payload.kind as 'chat' | 'task' | 'broadcast' | undefined) ?? 'chat';
  const replyTo = typeof msg.payload.replyTo === 'string' ? msg.payload.replyTo : null;
  const toId = stripLocal(msg.to);
  return buildEnvelope({
    fromKind: 'agent',
    fromAddress: msg.from,
    fromLookup: { instanceId: fromId, memberName: fromId, displayName: fromId },
    toAddress: msg.to,
    toLookup: msg.to.startsWith(LOCAL)
      ? { instanceId: toId, memberName: toId, displayName: toId }
      : null,
    summary,
    content,
    kind,
    replyTo,
    generateId: () => msg.id,
    now: () => new Date(msg.ts),
  });
}
