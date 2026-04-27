// 纯类型层。不 import 任何业务代码（bus / db / comm / config）。
// W1-G：通知系统契约。三种 mode：
//   - 'proxy_all'：所有白名单事件代理给 primary agent（primary 不在线 → fallback direct）
//   - 'direct'：直接推给前端 user 连接
//   - 'custom'：按 rules 自顶向下首命中路由；全不命中即 drop
// 业务侧（bus/subscribers/notification.subscriber.ts）只消费这些类型，不反向依赖。

export type ProxyMode = 'proxy_all' | 'direct' | 'custom';

/** custom 模式下单条规则的目标接收方（discriminated union，kind 判别）。 */
export type CustomRuleTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' }; // 显式忽略，命中即不发（与"全不命中"等价路径但语义明确）

export interface CustomRule {
  /** 匹配 bus 事件 type；支持 '*' 通配后缀，如 'team.*'；不支持前缀/中缀通配。 */
  matchType: string;
  to: CustomRuleTarget;
}

export interface NotificationConfig {
  /** 单用户场景固定 'default'；多用户接入时按 userId 一一对应。 */
  id: string;
  /** null = 系统缺省（未绑定具体用户）。 */
  userId: string | null;
  mode: ProxyMode;
  /** 仅 mode='custom' 时有意义，按数组顺序匹配。 */
  rules?: CustomRule[];
  updatedAt: string;
}

/**
 * 系统可通知的 bus 事件类型白名单。
 * 不在此集合的事件不走通知系统，仅通过普通 WS 订阅路径推送。
 * 与 bus/types.ts BusEventType 对齐；新增通知化事件时两边一起改。
 */
export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'instance.created',
  'instance.deleted',
  'instance.offline_requested',
  'team.created',
  'team.disbanded',
  'team.member_joined',
  'team.member_left',
  'container.crashed',
  'driver.error',
]);

export interface NotificationStore {
  /** 无配置时返回系统缺省 default（mode='proxy_all' 约定由实现层保证）。 */
  get(userId: string | null): NotificationConfig;
  upsert(cfg: NotificationConfig): void;
}

// ────── 类型守卫 ──────
// 运行期做窄化，避免 DAO 层/订阅层重复手写判断。

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'proxy_all' || value === 'direct' || value === 'custom';
}

export function isNotifiableEventType(type: string): boolean {
  return NOTIFIABLE_EVENT_TYPES.has(type);
}

export function isCustomRuleTarget(value: unknown): value is CustomRuleTarget {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'primary_agent' || kind === 'drop') return true;
  if (kind === 'user') return typeof (value as { userId?: unknown }).userId === 'string';
  if (kind === 'agent') return typeof (value as { instanceId?: unknown }).instanceId === 'string';
  return false;
}

export function isCustomRule(value: unknown): value is CustomRule {
  if (value === null || typeof value !== 'object') return false;
  const r = value as { matchType?: unknown; to?: unknown };
  return typeof r.matchType === 'string' && isCustomRuleTarget(r.to);
}

export function isNotificationConfig(value: unknown): value is NotificationConfig {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string') return false;
  if (c.userId !== null && typeof c.userId !== 'string') return false;
  if (!isProxyMode(c.mode)) return false;
  if (typeof c.updatedAt !== 'string') return false;
  if (c.rules === undefined) return true;
  return Array.isArray(c.rules) && c.rules.every(isCustomRule);
}

/**
 * custom 规则匹配：支持尾部 '*' 通配，如 'team.*' 命中 'team.created' / 'team.disbanded'。
 * 无通配时要求完全相等。实现抽到这里是为让订阅层和 DAO 单测共用同一份语义。
 */
export function matchRule(rule: CustomRule, eventType: string): boolean {
  const m = rule.matchType;
  if (m.endsWith('.*')) return eventType.startsWith(m.slice(0, -1));
  return m === eventType;
}
