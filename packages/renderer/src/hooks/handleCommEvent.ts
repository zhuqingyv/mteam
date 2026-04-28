// S4-G2b：comm.message_sent / comm.message_received → messageStore 双桶写入。
//
// 契约（INTERFACE-CONTRACTS §10.2 / §10.3）：
// - envelope.from / envelope.to 是 ActorRef（{ kind, address, instanceId?, displayName? }）
// - A→B 的同一条消息要同时写入 byInstance[A]（kind='comm-out' peerId=to）
//   和 byInstance[B]（kind='comm-in' peerId=from），双方展开都能看到
// - 同 msgId 在每个桶独立去重
//
// 纯函数 extractPeerId / eventToCommRecord 便于单测；handleCommEvent 是 React/WS 侧薄壳。

import { useMessageStore } from '../store';
import type { Message, MessageKind } from '../types/chat';

export interface ActorRef {
  kind?: 'user' | 'agent' | 'system' | string;
  address?: string;
  instanceId?: string | null;
  displayName?: string | null;
  memberName?: string | null;
  origin?: 'local' | 'remote' | string;
}

export interface CommEnvelope {
  id?: string;
  messageId?: string;
  from?: ActorRef;
  to?: ActorRef;
  content?: string;
  text?: string;
  kind?: string;
  ts?: string;
}

// 从 envelope.address 形如 "local:<id>" / "user:<uid>" 里取末段 id。
function parseAddressId(address: string | undefined): string | null {
  if (!address) return null;
  const i = address.indexOf(':');
  if (i < 0) return address;
  return address.slice(i + 1) || null;
}

/**
 * peer id 提取口径（§10.2 extractPeerId）：
 * - user 一律归到 'user'
 * - agent 优先 instanceId，否则从 address 解析
 */
export function extractPeerId(actor: ActorRef | undefined): string | null {
  if (!actor) return null;
  if (actor.kind === 'user') return 'user';
  if (actor.instanceId) return actor.instanceId;
  return parseAddressId(actor.address);
}

function formatTime(ts: string | undefined): string {
  const d = ts ? new Date(ts) : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface CommRecord {
  fromId: string | null;  // agent 桶 id；user→X 时为 null（不往 user 桶写）
  toId: string | null;    // agent 桶 id；X→user 时为 null
  outbound: Message | null; // 写入 fromId 桶的消息
  inbound: Message | null;  // 写入 toId 桶的消息
}

/**
 * 把一条 comm envelope 展开成最多两条桶消息（outbound/inbound）。
 * - msgId 缺失 → 用 fallback 'comm-' + Date.now()，仍然保证同桶内 id 唯一
 * - content / text 任一缺失都视为空字符串，保证消息结构完整
 */
export function eventToCommRecord(env: CommEnvelope): CommRecord {
  const msgId = String(env.id ?? env.messageId ?? `comm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const fromPeer = extractPeerId(env.from);
  const toPeer = extractPeerId(env.to);
  const text = String(env.content ?? env.text ?? '');
  const time = formatTime(env.ts);
  const ts = env.ts;

  // agent 桶 id：只接受非 'user'/非空。user 桶不存在于 messageStore，不写。
  const fromBucketId = fromPeer && fromPeer !== 'user' ? fromPeer : null;
  const toBucketId = toPeer && toPeer !== 'user' ? toPeer : null;

  const outbound: Message | null = fromBucketId && toPeer
    ? {
        id: msgId,
        role: 'user',
        content: text,
        time,
        ts,
        read: false,
        peerId: toPeer,
        kind: 'comm-out' as MessageKind,
      }
    : null;

  const inbound: Message | null = toBucketId && fromPeer
    ? {
        id: msgId,
        role: 'agent',
        content: text,
        time,
        ts,
        read: false,
        peerId: fromPeer,
        kind: 'comm-in' as MessageKind,
        agentName: env.from?.displayName ?? env.from?.memberName ?? undefined,
      }
    : null;

  return { fromId: fromBucketId, toId: toBucketId, outbound, inbound };
}

/**
 * 接收 WS comm.* 事件，做双桶写入。
 * 每个桶按 msgId 独立去重（同一事件重复推送不会重复写）。
 */
export function handleCommEvent(_t: string, e: Record<string, unknown>): void {
  // envelope 可能是平铺也可能嵌在 payload/envelope 下；按常见命名兼容。
  const raw = (e.envelope ?? e.payload ?? e) as CommEnvelope | undefined;
  if (!raw) return;
  const rec = eventToCommRecord(raw);
  const ms = useMessageStore.getState();

  if (rec.outbound && rec.fromId) {
    const bucket = ms.byInstance[rec.fromId];
    if (!bucket?.messages.some((m) => m.id === rec.outbound!.id)) {
      ms.addMessageFor(rec.fromId, rec.outbound);
    }
  }
  if (rec.inbound && rec.toId) {
    const bucket = ms.byInstance[rec.toId];
    if (!bucket?.messages.some((m) => m.id === rec.inbound!.id)) {
      ms.addMessageFor(rec.toId, rec.inbound);
    }
  }
}
