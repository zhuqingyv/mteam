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
import { WsBroadcaster } from './subscribers/ws.subscriber.js';
import type { CommRouter } from '../comm/router.js';

export { bus, EventBus } from './events.js';
export type { BusEvent, BusEventType } from './events.js';

// WebSocket 广播器单例：server.ts 的 upgrade handler 会 addClient。
export const wsBroadcaster = new WsBroadcaster();

let masterSub: Subscription | null = null;

export function bootSubscribers(deps: { commRouter: CommRouter }): void {
  if (masterSub) return;
  masterSub = new Subscription();
  masterSub.add(subscribeRoster());
  // team 必须在 pty 之前注册：leader instance.created 先建 team，
  // 才能保证后续 pty.spawn → CLI 启动 → mteam MCP 能通过 HTTP 查到 self.teamId。
  // （实际不依赖执行顺序——Subject 分发同步，team.create 是同步 DB 写入；
  // 但注册顺序保持与"建 team 先于 spawn"的因果顺序一致，便于排查。）
  masterSub.add(subscribeTeam());
  masterSub.add(subscribePty());
  masterSub.add(subscribeDomainSync());
  masterSub.add(subscribeCommNotify(deps.commRouter));
  masterSub.add(subscribeLog());
  wsBroadcaster.start();
}

export function teardownSubscribers(): void {
  if (masterSub) {
    masterSub.unsubscribe();
    masterSub = null;
  }
  wsBroadcaster.stop();
  bus.destroy();
}
