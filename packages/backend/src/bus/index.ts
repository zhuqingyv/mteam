// Subscriber 注册中心：聚合所有 subscriber 的生命周期管理。
// server.ts 启动时调 bootSubscribers()，shutdown 时调 teardownSubscribers()。
// bus 是模块级单例，destroy() 后 Subject 永久 complete，生产进程里只应被调一次。
import { Subscription } from 'rxjs';
import { bus } from './events.js';
import { subscribeRoster } from './subscribers/roster.subscriber.js';
import { subscribePty } from './subscribers/pty.subscriber.js';
import { subscribeDomainSync } from './subscribers/domain-sync.subscriber.js';
import { subscribeCommNotify } from './subscribers/comm-notify.subscriber.js';
import { subscribeLog } from './subscribers/log.subscriber.js';
import { subscribeTeam } from './subscribers/team.subscriber.js';
import { subscribeNotification, type NotifSubDeps } from './subscribers/notification.subscriber.js';
import { subscribeTurnAggregator, type TurnAggregator } from './subscribers/turn-aggregator.subscriber.js';
import { subscribeTurnHistory } from './subscribers/turn-history.subscriber.js';
import { insertTurn } from '../turn-history/repo.js';
import { WsBroadcaster } from './subscribers/ws.subscriber.js';
import type { CommRouter } from '../comm/router.js';

export { bus, EventBus } from './events.js';
export type { BusEvent, BusEventType } from './events.js';

// WebSocket 广播器单例：server.ts 的 upgrade handler 会 addClient。
export const wsBroadcaster = new WsBroadcaster();

let masterSub: Subscription | null = null;
let aggregatorHandle: TurnAggregator | null = null;

export interface BootSubscribersDeps {
  commRouter: CommRouter;
  // A3 注入的 notification 胶水依赖；缺省时跳过通知 subscriber。
  notification?: NotifSubDeps;
}

// Stage 5 可选能力开关：policy / sandbox（container）目前未在此处挂载，
// 仅签名预留给调用方（http/server.ts 已开始传），下一阶段按需接入。
export interface BootSubscribersOpts {
  sandbox?: { enabled: boolean; transport?: 'http' | 'stdio' };
  policy?: { enabled: boolean };
}

export function bootSubscribers(
  deps: BootSubscribersDeps,
  _opts?: BootSubscribersOpts,
): void {
  if (masterSub) return;
  masterSub = new Subscription();
  masterSub.add(subscribeRoster());
  // team 必须在 pty 之前注册：leader instance.created 先建 team，
  // 才能保证后续 pty.spawn → CLI 启动 → mteam MCP 能通过 HTTP 查到 self.teamId。
  masterSub.add(subscribeTeam());
  masterSub.add(subscribePty());
  masterSub.add(subscribeDomainSync());
  masterSub.add(subscribeCommNotify(deps.commRouter));
  masterSub.add(subscribeLog());
  if (deps.notification) {
    masterSub.add(subscribeNotification(deps.notification));
  }
  // Turn 聚合：暴露 aggregator 给 ws handler / HTTP 快照（getTurnAggregator()）。
  const { aggregator, subscription } = subscribeTurnAggregator(bus);
  aggregatorHandle = aggregator;
  masterSub.add(subscription);
  // Turn 历史：turn.completed → turn_history.insertTurn
  masterSub.add(subscribeTurnHistory(bus, { insertTurn }));
  wsBroadcaster.start();
}

export function teardownSubscribers(): void {
  if (masterSub) {
    masterSub.unsubscribe();
    masterSub = null;
  }
  aggregatorHandle = null;
  wsBroadcaster.stop();
  bus.destroy();
}

// WS handler / HTTP 快照调用：启动早期 aggregator 未就绪会返回 null，
// 调用方自行处理（返回空快照）。
export function getTurnAggregator(): TurnAggregator | null {
  return aggregatorHandle;
}
