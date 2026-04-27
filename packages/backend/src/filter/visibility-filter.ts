// Phase WS · W2-4：可见性过滤器业务胶水。
//
// 默认策略：`default_allow`。若未来接多租户/多用户且要求白名单模式，新增
// `default_policy: 'allow' | 'deny'` 配置入 `filter_configs` 表，由
// `createVisibilityFilter(store, opts)` 注入；**不要**硬改本算法。
// arch-ws-b 审查同意本期保留 default_allow。
//
// 纯函数 + 每次 canSee 直读 store（不缓存），让 filter-store 运行期 upsert
// 立即对后续事件生效（REGRESSION R2-5）。
//
// target 抽取表（README 另有对照）：
//   comm.message_sent / comm.message_received → [from, to]
//   comm.registered / comm.disconnected       → [address]
//   driver.*                                  → [instanceId]（driverId===instanceId）
//   team.*                                    → [teamId]
//   instance.*                                → [instanceId]
//   container.*                               → [agentId]（host 模式 agentId===instanceId）
//   primary_agent.*                           → [agentId]
//   其余（template.* / mcp.* / cli.*）         → []
//
// 事件里抽不出 target 时，视作"全局事件"——无规则可命中，落到 default_allow。

import type { BusEvent } from '../bus/types.js';
import type {
  ActorPrincipal,
  FilterStore,
  RuleTarget,
  VisibilityDecision,
  VisibilityRule,
} from './types.js';

export interface VisibilityFilter {
  canSee(principal: ActorPrincipal, event: BusEvent): boolean;
  decide(principal: ActorPrincipal, event: BusEvent): VisibilityDecision;
}

const DEFAULT_ALLOW: VisibilityDecision = {
  decision: 'allow',
  byRuleId: 'default_allow',
};

export function createVisibilityFilter(store: FilterStore): VisibilityFilter {
  function decide(
    principal: ActorPrincipal,
    event: BusEvent,
  ): VisibilityDecision {
    const targets = extractTargets(event);
    if (targets.length === 0) return DEFAULT_ALLOW;

    const rules = store.listForPrincipal(principal);
    if (rules.length === 0) return DEFAULT_ALLOW;

    // deny 先扫一遍 → 命中任一 target 立即短路。
    for (const rule of rules) {
      if (rule.effect !== 'deny') continue;
      if (targetsHit(targets, rule.target)) {
        return { decision: 'deny', byRuleId: rule.id };
      }
    }
    for (const rule of rules) {
      if (rule.effect !== 'allow') continue;
      if (targetsHit(targets, rule.target)) {
        return { decision: 'allow', byRuleId: rule.id };
      }
    }
    return DEFAULT_ALLOW;
  }

  return {
    decide,
    canSee(principal, event) {
      return decide(principal, event).decision === 'allow';
    },
  };
}

// ----------------------------------------------------------------------------
// target 抽取（纯函数，不触 bus / db）
// ----------------------------------------------------------------------------

type ExtractedTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'team'; teamId: string };

function extractTargets(event: BusEvent): ExtractedTarget[] {
  switch (event.type) {
    case 'comm.message_sent':
    case 'comm.message_received':
      return [parseAddress(event.from), parseAddress(event.to)].flatMap((t) =>
        t ? [t] : [],
      );
    case 'comm.registered':
    case 'comm.disconnected': {
      const t = parseAddress(event.address);
      return t ? [t] : [];
    }
    case 'driver.started':
    case 'driver.stopped':
    case 'driver.error':
    case 'driver.thinking':
    case 'driver.text':
    case 'driver.tool_call':
    case 'driver.tool_result':
    case 'driver.turn_done':
      return [{ kind: 'agent', instanceId: event.driverId }];
    case 'team.created':
    case 'team.disbanded':
      return [{ kind: 'team', teamId: event.teamId }];
    case 'team.member_joined':
    case 'team.member_left':
      return [
        { kind: 'team', teamId: event.teamId },
        { kind: 'agent', instanceId: event.instanceId },
      ];
    case 'instance.created':
    case 'instance.activated':
    case 'instance.offline_requested':
    case 'instance.deleted':
    case 'instance.session_registered':
      return [{ kind: 'agent', instanceId: event.instanceId }];
    case 'container.started':
    case 'container.exited':
    case 'container.crashed':
      return [{ kind: 'agent', instanceId: event.agentId }];
    case 'primary_agent.started':
    case 'primary_agent.stopped':
    case 'primary_agent.configured':
      return [{ kind: 'agent', instanceId: event.agentId }];
    default:
      return [];
  }
}

// comm.* 里的 address 形如 `user:u1` / `agent:inst_x` / `team:t1` / `system`。
// 解析不了或 kind 不在目标域里的（例如 system）返回 null，视作不可过滤。
function parseAddress(address: string): ExtractedTarget | null {
  const colon = address.indexOf(':');
  if (colon <= 0) return null;
  const kind = address.slice(0, colon);
  const ref = address.slice(colon + 1);
  if (!ref) return null;
  if (kind === 'user') return { kind: 'user', userId: ref };
  if (kind === 'agent') return { kind: 'agent', instanceId: ref };
  if (kind === 'team') return { kind: 'team', teamId: ref };
  return null;
}

function targetsHit(
  extracted: ExtractedTarget[],
  ruleTarget: VisibilityRule['target'],
): boolean {
  for (const t of extracted) {
    if (matchTarget(t, ruleTarget)) return true;
  }
  return false;
}

function matchTarget(a: ExtractedTarget, b: RuleTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId;
  if (a.kind === 'agent' && b.kind === 'agent')
    return a.instanceId === b.instanceId;
  if (a.kind === 'team' && b.kind === 'team') return a.teamId === b.teamId;
  return false;
}
