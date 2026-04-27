// Stage 5 M7 · policy.subscriber —— 基于白名单的事后强制下线。
//
// 订阅 driver.tool_call → 查 (template+global) 规则 → 违规直接 emit
// instance.offline_requested(requestedBy='policy-enforcer', reason)，
// 不再走取消的 policy.violated 中间事件。
//
// driverKey === instanceId === event.driverId（P1-8 钉死口径），不做反查。
// 详细时序 / correlationId 透传 / 审计链路见同目录 POLICY-README.md。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { mergeRules } from '../../policy/rule-merger.js';
import { evaluate } from '../../policy/rule-matcher.js';
import type { RuleLoader } from '../../policy/rule-loader.js';

export interface PolicySubscriberDeps {
  ruleLoader: RuleLoader;
}

export interface PolicySubscriberConfig {
  enabled: boolean;
  configPath?: string;
}

type ViolationReason = 'explicit_deny' | 'not_in_whitelist';

export function subscribePolicy(
  config: PolicySubscriberConfig,
  deps: PolicySubscriberDeps,
  eventBus: EventBus = defaultBus,
): Subscription {
  const sub = new Subscription();
  // enabled=false：直接返回空 Subscription，不注册订阅。
  // 由 bootSubscribers 决定是否启用，这里只做"听令"，不内卷。
  if (!config.enabled) return sub;

  const { ruleLoader } = deps;

  sub.add(
    eventBus.on('driver.tool_call').subscribe((e) => {
      try {
        const reason = judge(e.driverId, e.name, ruleLoader);
        if (!reason) return; // allow / default-allow：静默放行
        eventBus.emit({
          ...makeBase('instance.offline_requested', 'bus/policy.subscriber', e.correlationId),
          instanceId: e.driverId,
          requestedBy: 'policy-enforcer',
          reason,
        });
      } catch (err) {
        process.stderr.write(
          `[bus/policy] handler failed for driverId=${e.driverId} tool=${e.name}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}

// 纯判定：返回违规原因 / null（放行）。
// - configured=false → default allow（未配置白名单的 instance 不拦截）
// - deny 命中 → explicit_deny
// - configured=true 且 no_match → not_in_whitelist
function judge(
  driverId: string,
  toolName: string,
  loader: RuleLoader,
): ViolationReason | null {
  const rules = mergeRules(loader.getTemplateAllow(driverId), loader.getGlobalRules());
  const decision = evaluate(toolName, rules);
  if (decision.verdict === 'deny') return 'explicit_deny';
  if (!rules.configured) return null; // default allow
  if (decision.verdict === 'allow') return null;
  return 'not_in_whitelist';
}
