// Subscriber 注册中心。bus 模块单例 destroy 后 Subject 永久 complete；测试注入 EventBus 隔离。
import { Subscription } from 'rxjs';
import { bus as defaultBus, EventBus } from './events.js';
import { subscribeRoster } from './subscribers/roster.subscriber.js';
import { subscribeDomainSync } from './subscribers/domain-sync.subscriber.js';
import { subscribeCommNotify } from './subscribers/comm-notify.subscriber.js';
import { subscribeLog } from './subscribers/log.subscriber.js';
import { subscribeTeam } from './subscribers/team.subscriber.js';
import { subscribeMemberDriver } from './subscribers/member-driver/index.js';
import { subscribeContainer, type ContainerSubscriberDeps } from './subscribers/container.subscriber.js';
import { subscribePolicy } from './subscribers/policy.subscriber.js';
import { subscribeNotification, type NotifSubDeps } from './subscribers/notification.subscriber.js';
import { subscribeTurnAggregator, type TurnAggregator } from './subscribers/turn-aggregator.subscriber.js';
import { subscribeTurnHistory } from './subscribers/turn-history.subscriber.js';
import { subscribeWorkerStatus } from './subscribers/worker-status.subscriber.js';
import { insertTurn } from '../turn-history/repo.js';
import { createContainerRegistry } from './subscribers/container-registry.js';
import { createRestartPolicy } from './subscribers/container-restart-policy.js';
import * as defaultSandbox from './subscribers/sandbox-deps.js';
import { createRuleLoader, type RuleLoader } from '../policy/rule-loader.js';
import type { CommRouter } from '../comm/router.js';
export { bus, EventBus } from './events.js';
export type { BusEvent, BusEventType } from './events.js';
// Stage 5：配置驱动的 subscriber 开关。环境变量都不设等同 Stage 3/4 形态。
export interface SubscriberConfig {
  sandbox?: { enabled: boolean; transport: 'http' | 'stdio'; restartPolicy?: { maxRestarts: number; backoffBaseMs: number }; containerDeps?: Omit<ContainerSubscriberDeps, 'registry' | 'restartPolicy'> };
  policy?: { enabled: boolean; configPath?: string };
}
let masterSub: Subscription | null = null;
let ruleLoader: RuleLoader | null = null;
let currentBus: EventBus | null = null;
let turnAggregator: TurnAggregator | null = null;

/** T-9：HTTP /api/panel/driver/:id/turns（T-10）从这里拿 aggregator。bootSubscribers 未跑时为 null。 */
export function getTurnAggregator(): TurnAggregator | null {
  return turnAggregator;
}

export interface BootDeps {
  commRouter: CommRouter;
  /** 传入即注册 notification.subscriber；省略则跳过（测试/最小启动兼容）。 */
  notification?: Omit<NotifSubDeps, never>;
}

export function bootSubscribers(
  deps: BootDeps,
  config: SubscriberConfig = {},
  eventBus: EventBus = defaultBus,
): void {
  if (masterSub) return;
  currentBus = eventBus;
  masterSub = new Subscription();
  masterSub.add(subscribeRoster(eventBus));
  masterSub.add(subscribeTeam(eventBus)); // team 必须先于 member-driver（同步分发的因果顺序）
  masterSub.add(subscribeMemberDriver({ eventBus }));
  masterSub.add(subscribeDomainSync(eventBus));
  masterSub.add(subscribeCommNotify(deps.commRouter, eventBus));
  masterSub.add(subscribeLog(eventBus));
  // T-9：turn 聚合器订阅 driver.* → emit turn.*。aggregator 句柄暴露给 T-10 HTTP 快照接口。
  const { aggregator, subscription: turnSub } = subscribeTurnAggregator(eventBus);
  turnAggregator = aggregator;
  masterSub.add(turnSub);
  // T3：turn-history 订阅器接 turn.completed → insertTurn（repo.ts）。
  // 必须晚于 aggregator（aggregator 才 emit turn.completed）。
  masterSub.add(subscribeTurnHistory(eventBus, { insertTurn }));
  // 数字员工状态增量推送：订阅 instance/driver/turn 触发事件 → emit worker.status_changed。
  masterSub.add(subscribeWorkerStatus(eventBus));
  if (deps.notification) masterSub.add(subscribeNotification(deps.notification, eventBus));
  if (config.sandbox?.enabled) {
    const registry = createContainerRegistry();
    const restartPolicy = createRestartPolicy(config.sandbox.restartPolicy);
    const cd = config.sandbox.containerDeps ?? defaultSandbox;
    masterSub.add(subscribeContainer(config.sandbox, { registry, restartPolicy, ...cd }, eventBus));
  }
  if (config.policy?.enabled) {
    ruleLoader = createRuleLoader({ configPath: config.policy.configPath });
    masterSub.add(subscribePolicy(config.policy, { ruleLoader }, eventBus));
  }
}

export function teardownSubscribers(): void {
  masterSub?.unsubscribe();
  masterSub = null;
  ruleLoader?.close();
  ruleLoader = null;
  turnAggregator = null;
  if (!currentBus || currentBus === defaultBus) defaultBus.destroy();
  currentBus = null;
}
