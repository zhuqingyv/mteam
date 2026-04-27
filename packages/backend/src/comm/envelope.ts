// mteam 通信模型信封类型 —— Part B（通信管道）唯一数据结构
// Why 独立文件：router / tool / subscriber / HTTP / DAO 全部 `import type`，
//     避免业务层脱壳成散字段，编译期强制对齐；本文件不 import 任何项目内模块。

export type ActorKind = 'user' | 'agent' | 'system';
export type MessageKind = 'chat' | 'task' | 'broadcast' | 'system';

export interface ActorRef {
  kind: ActorKind;
  address: string;
  displayName: string;
  instanceId?: string | null;
  memberName?: string | null;
  origin?: 'local' | 'remote';
}

export interface MessageEnvelope {
  id: string;
  from: ActorRef;
  to: ActorRef;
  teamId: string | null;
  kind: MessageKind;
  summary: string;
  content?: string;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}

const ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'system'];
const MESSAGE_KINDS: readonly MessageKind[] = ['chat', 'task', 'broadcast', 'system'];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isNullableString(x: unknown): x is string | null | undefined {
  return x === null || x === undefined || typeof x === 'string';
}

export function isActorRef(x: unknown): x is ActorRef {
  if (!isRecord(x)) return false;
  if (!ACTOR_KINDS.includes(x.kind as ActorKind)) return false;
  if (typeof x.address !== 'string' || x.address.length === 0) return false;
  if (typeof x.displayName !== 'string') return false;
  if (!isNullableString(x.instanceId)) return false;
  if (!isNullableString(x.memberName)) return false;
  if (x.origin !== undefined && x.origin !== 'local' && x.origin !== 'remote') return false;
  return true;
}

export function isMessageEnvelope(x: unknown): x is MessageEnvelope {
  if (!isRecord(x)) return false;
  if (typeof x.id !== 'string' || x.id.length === 0) return false;
  if (!isActorRef(x.from)) return false;
  if (!isActorRef(x.to)) return false;
  if (x.teamId !== null && typeof x.teamId !== 'string') return false;
  if (!MESSAGE_KINDS.includes(x.kind as MessageKind)) return false;
  if (typeof x.summary !== 'string') return false;
  if (x.content !== undefined && typeof x.content !== 'string') return false;
  if (x.replyTo !== null && typeof x.replyTo !== 'string') return false;
  if (typeof x.ts !== 'string') return false;
  if (x.readAt !== null && typeof x.readAt !== 'string') return false;
  if (x.attachments !== undefined) {
    if (!Array.isArray(x.attachments)) return false;
    for (const a of x.attachments) {
      if (!isRecord(a) || typeof a.type !== 'string') return false;
    }
  }
  return true;
}
