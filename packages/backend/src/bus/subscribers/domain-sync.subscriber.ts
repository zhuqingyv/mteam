// Domain-sync subscriber —— 把运行时事件的副作用回写到 domain 层。
// 当前为空壳：原 session_pid 回写逻辑已迁移到 W2-1c pid-writeback
// （订阅 driver.started 写 role_instances.session_pid）。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function subscribeDomainSync(_eventBus: EventBus = defaultBus): Subscription {
  return new Subscription();
}
