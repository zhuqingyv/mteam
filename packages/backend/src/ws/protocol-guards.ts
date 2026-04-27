// WS 上行消息类型守卫。从 protocol.ts 抽出压行数。
// 规则：
//   - 对象且 op 为已知字面量之一
//   - 必填字段类型正确
//   - 额外字段一律拒（防止前端传入后端忽略但未来又启用的隐形耦合）
import type { SubscriptionScope, WsUpstream } from './protocol.js';

const SCOPES: ReadonlySet<SubscriptionScope> = new Set([
  'global',
  'team',
  'instance',
  'user',
]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isOptString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === 'string';
}

function isOptPositiveInt(x: unknown): x is number | undefined {
  return x === undefined || (typeof x === 'number' && Number.isInteger(x) && x > 0);
}

function isSubscriptionScope(x: unknown): x is SubscriptionScope {
  return typeof x === 'string' && SCOPES.has(x as SubscriptionScope);
}

const SUBSCRIBE_KEYS = new Set(['op', 'scope', 'id', 'lastMsgId']);
const UNSUBSCRIBE_KEYS = new Set(['op', 'scope', 'id']);
const PROMPT_KEYS = new Set(['op', 'instanceId', 'text', 'requestId']);
const PING_KEYS = new Set(['op']);
const CONFIGURE_PRIMARY_AGENT_KEYS = new Set([
  'op', 'cliType', 'name', 'systemPrompt', 'requestId',
]);
const GET_TURNS_KEYS = new Set(['op', 'driverId', 'limit', 'requestId']);
const GET_TURN_HISTORY_KEYS = new Set([
  'op', 'driverId', 'limit', 'beforeEndTs', 'beforeTurnId', 'requestId',
]);

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return false;
  return true;
}

export function isWsUpstream(x: unknown): x is WsUpstream {
  if (!isPlainObject(x)) return false;
  switch (x.op) {
    case 'subscribe':
      return (
        hasOnlyKeys(x, SUBSCRIBE_KEYS) &&
        isSubscriptionScope(x.scope) &&
        isOptString(x.id) &&
        isOptString(x.lastMsgId)
      );
    case 'unsubscribe':
      return (
        hasOnlyKeys(x, UNSUBSCRIBE_KEYS) &&
        isSubscriptionScope(x.scope) &&
        isOptString(x.id)
      );
    case 'prompt':
      return (
        hasOnlyKeys(x, PROMPT_KEYS) &&
        typeof x.instanceId === 'string' &&
        x.instanceId.length > 0 &&
        typeof x.text === 'string' &&
        isOptString(x.requestId)
      );
    case 'ping':
      return hasOnlyKeys(x, PING_KEYS);
    case 'configure_primary_agent':
      return (
        hasOnlyKeys(x, CONFIGURE_PRIMARY_AGENT_KEYS) &&
        typeof x.cliType === 'string' &&
        x.cliType.length > 0 &&
        isOptString(x.name) &&
        isOptString(x.systemPrompt) &&
        isOptString(x.requestId)
      );
    case 'get_turns':
      return (
        hasOnlyKeys(x, GET_TURNS_KEYS) &&
        typeof x.driverId === 'string' &&
        x.driverId.length > 0 &&
        isOptPositiveInt(x.limit) &&
        isOptString(x.requestId)
      );
    case 'get_turn_history':
      return (
        hasOnlyKeys(x, GET_TURN_HISTORY_KEYS) &&
        typeof x.driverId === 'string' &&
        x.driverId.length > 0 &&
        isOptPositiveInt(x.limit) &&
        isOptString(x.beforeEndTs) &&
        isOptString(x.beforeTurnId) &&
        isOptString(x.requestId)
      );
    default:
      return false;
  }
}
