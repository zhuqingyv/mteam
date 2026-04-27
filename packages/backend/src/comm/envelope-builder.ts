// comm/envelope-builder.ts — W1-B
// 纯函数：把调用方查好的事实组装成 MessageEnvelope。
// Why 强注入 fromKind：防伪造。HTTP=user / MCP=agent / subscriber=system；
// 调用方无法通过 body 字段改写身份。
import { randomUUID } from 'node:crypto';
import type {
  ActorKind,
  ActorRef,
  MessageEnvelope,
  MessageKind,
} from './envelope.js';

export interface AgentLookup {
  instanceId: string;
  memberName: string;
  displayName: string; // alias 优先，其次 memberName
}

export interface BuildEnvelopeInput {
  fromKind: ActorKind;
  fromAddress: string;
  /** agent 场景必填；user/system 传 null/undefined。 */
  fromLookup?: AgentLookup | null;
  /** user/system displayName 覆盖，默认 'User' / '系统'。 */
  fromDisplayNameOverride?: string;

  toAddress: string;
  toLookup?: AgentLookup | null;

  summary: string | null | undefined; // 空时填 DEFAULT_SUMMARY
  content: string | undefined;
  kind?: MessageKind; // 默认 'chat'
  replyTo?: string | null;
  teamId?: string | null;
  attachments?: MessageEnvelope['attachments'];

  now?: () => Date;
  generateId?: () => string;
}

export interface BuildEnvelopeOptions {
  /** 仅 system 入口（bus subscriber）放行 kind='system'。 */
  allowSystemKind?: boolean;
}

const DEFAULT_SUMMARY = '给你发了一条消息';
const SYSTEM_ADDRESS = 'local:system';

function isEmpty(s: string | null | undefined): boolean {
  return s == null || String(s).trim() === '';
}

function agentActor(addr: string, lk: AgentLookup): ActorRef {
  return {
    kind: 'agent',
    address: addr,
    displayName: lk.displayName,
    instanceId: lk.instanceId,
    memberName: lk.memberName,
    origin: 'local',
  };
}

function nonAgentActor(
  kind: 'user' | 'system',
  address: string,
  displayName: string,
): ActorRef {
  return {
    kind,
    address,
    displayName,
    instanceId: null,
    memberName: null,
    origin: 'local',
  };
}

function buildFrom(i: BuildEnvelopeInput): ActorRef {
  if (i.fromKind === 'agent') {
    if (!i.fromLookup) {
      throw new Error('buildEnvelope: fromLookup required when fromKind="agent"');
    }
    return agentActor(i.fromAddress, i.fromLookup);
  }
  const override = i.fromDisplayNameOverride?.trim();
  const displayName = override || (i.fromKind === 'system' ? '系统' : 'User');
  const address = i.fromKind === 'system' ? SYSTEM_ADDRESS : i.fromAddress;
  return nonAgentActor(i.fromKind, address, displayName);
}

function buildTo(i: BuildEnvelopeInput): ActorRef {
  const addr = i.toAddress;
  if (i.toLookup) return agentActor(addr, i.toLookup);
  if (addr === SYSTEM_ADDRESS) return nonAgentActor('system', addr, '系统');
  if (addr.startsWith('user:')) return nonAgentActor('user', addr, 'User');
  throw new Error(
    `buildEnvelope: toLookup is required for agent address "${addr}"`,
  );
}

export function buildEnvelope(
  input: BuildEnvelopeInput,
  options: BuildEnvelopeOptions = {},
): MessageEnvelope {
  const kind: MessageKind = input.kind ?? 'chat';
  if (kind === 'system' && !options.allowSystemKind) {
    throw new Error('buildEnvelope: kind="system" is not allowed from this entry');
  }
  const genId = input.generateId ?? (() => `msg_${randomUUID()}`);
  const now = (input.now ?? (() => new Date()))();
  return {
    id: genId(),
    from: buildFrom(input),
    to: buildTo(input),
    teamId: input.teamId ?? null,
    kind,
    summary: isEmpty(input.summary) ? DEFAULT_SUMMARY : String(input.summary),
    content: input.content,
    replyTo: input.replyTo ?? null,
    ts: now.toISOString(),
    readAt: null,
    attachments: input.attachments,
  };
}
