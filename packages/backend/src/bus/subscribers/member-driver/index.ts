// member-driver —— 聚合入口，把 lifecycle + pid-writeback 打包成一条 Subscription。
// replay 是纯函数由 lifecycle 内部 await，不在这里挂 bus。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../../events.js';
import { subscribeMemberDriverLifecycle } from './lifecycle.js';
import { subscribePidWriteback } from './pid-writeback.js';
import type { DriverRegistry } from '../../../agent-driver/registry.js';
import type { ProcessRuntime } from '../../../process-runtime/types.js';

export interface SubscribeMemberDriverDeps {
  eventBus?: EventBus;
  registry?: DriverRegistry;
  runtime?: ProcessRuntime;
  hubUrl?: string;
  commSock?: string;
}

export function subscribeMemberDriver(deps: SubscribeMemberDriverDeps = {}): Subscription {
  const eventBus = deps.eventBus ?? defaultBus;
  const master = new Subscription();
  master.add(subscribeMemberDriverLifecycle({
    eventBus, registry: deps.registry, runtime: deps.runtime,
    hubUrl: deps.hubUrl, commSock: deps.commSock,
  }));
  master.add(subscribePidWriteback({ eventBus }));
  return master;
}
