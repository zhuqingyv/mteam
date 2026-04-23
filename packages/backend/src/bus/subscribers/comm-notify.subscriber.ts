// Comm notify subscriber —— 补全旧架构遗漏的副作用：
// leader 批准下线（instance.offline_requested）后，给目标成员发系统消息。
//
// 走 CommRouter.dispatch，from=local:system，to=local:<instanceId>，
// payload 里带 kind=system / action=deactivate，便于成员端按 action 处理。
import { Subscription } from 'rxjs';
import { EventBus, bus } from '../events.js';
import type { CommRouter } from '../../comm/router.js';
import type { Message, Address } from '../../comm/types.js';

export function subscribeCommNotify(
  router: CommRouter,
  eventBus: EventBus = bus,
): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.offline_requested').subscribe((e) => {
      try {
        const msg: Message = {
          type: 'message',
          id: `sys-offline-${e.instanceId}-${Date.now()}`,
          from: 'local:system' as Address,
          to: `local:${e.instanceId}` as Address,
          payload: {
            kind: 'system',
            summary: 'Leader has approved your offline request',
            action: 'deactivate',
          },
          ts: e.ts,
        };
        router.dispatch(msg);
      } catch (err) {
        process.stderr.write(
          `[bus] comm-notify dispatch failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
