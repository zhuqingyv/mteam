// Domain-sync subscriber —— 把 PTY 产生的副作用回写到 domain 层。
// 目前只做一件事：pty.spawned → instance.setSessionPid(pid)。
// 拆成独立 subscriber 是为了 pty.subscriber 不依赖 domain，职责单一。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { RoleInstance } from '../../domain/role-instance.js';

export function subscribeDomainSync(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('pty.spawned').subscribe((e) => {
      try {
        const instance = RoleInstance.findById(e.instanceId);
        if (!instance) {
          process.stderr.write(
            `[bus/domain-sync] instance ${e.instanceId} not found, cannot setSessionPid\n`,
          );
          return;
        }
        instance.setSessionPid(e.pid);
      } catch (err) {
        process.stderr.write(
          `[bus/domain-sync] setSessionPid failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
