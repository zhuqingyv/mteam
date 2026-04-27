// Phase WS · W1-E：可见性规则纯类型定义。
// 本文件只导出 type / interface，不含运行时副作用、不 import 任何业务代码。
// 业务实现（visibility-filter / filter-store）靠 `import type` 吃这份契约。

/** 可观测主体。team 不在此列 —— 只有 user / agent / system 会"看"消息。 */
export type ActorPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'system' };

/** 规则的目标（被看方）。team 作为目标合法，代表"发给 / 来自该团队广播的事件"。 */
export type RuleTarget =
  | ActorPrincipal
  | { kind: 'team'; teamId: string };

/**
 * 一条可见性规则：描述"主体 principal 能否看到发出/发给 target 的消息/事件"。
 * 多条规则时 deny 优先短路（见 visibility-filter W2-4）。
 */
export interface VisibilityRule {
  id: string;
  principal: ActorPrincipal;
  target: RuleTarget;
  effect: 'allow' | 'deny';
  /** 给 UI 展示的规则说明。可选。 */
  note?: string;
  /** ISO-8601 字符串，由 filter-store 落库时填入。 */
  createdAt: string;
}

/**
 * 过滤判定结果。
 * - decision='allow' 且 byRuleId='default_allow'：无规则命中时的兜底。
 * - 其他情况下 byRuleId 指向具体 VisibilityRule.id，便于 UI / 日志溯源。
 */
export type VisibilityDecision =
  | { decision: 'allow'; byRuleId: string | 'default_allow' }
  | { decision: 'deny'; byRuleId: string };

/** DAO 抽象，由 filter-store (W1-F) 实现为 SQLite 读写。 */
export interface FilterStore {
  list(): VisibilityRule[];
  listForPrincipal(p: ActorPrincipal): VisibilityRule[];
  upsert(rule: VisibilityRule): void;
  remove(id: string): void;
}

// ----------------------------------------------------------------------------
// 类型守卫
// ----------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

export function isActorPrincipal(x: unknown): x is ActorPrincipal {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case 'user':
      return isNonEmptyString(x.userId);
    case 'agent':
      return isNonEmptyString(x.instanceId);
    case 'system':
      return true;
    default:
      return false;
  }
}

export function isRuleTarget(x: unknown): x is RuleTarget {
  if (!isPlainObject(x)) return false;
  if (x.kind === 'team') return isNonEmptyString(x.teamId);
  return isActorPrincipal(x);
}

export function isVisibilityRule(x: unknown): x is VisibilityRule {
  if (!isPlainObject(x)) return false;
  if (!isNonEmptyString(x.id)) return false;
  if (!isActorPrincipal(x.principal)) return false;
  if (!isRuleTarget(x.target)) return false;
  if (x.effect !== 'allow' && x.effect !== 'deny') return false;
  if (x.note !== undefined && typeof x.note !== 'string') return false;
  if (!isNonEmptyString(x.createdAt)) return false;
  return true;
}
