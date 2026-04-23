// Roster subscriber —— 把 instance.* 事件映射到 roster DAO 写入。
//
// 注意：roster.add 要求 role_instances 行已存在（domain 层已插好），
// 所以 handler 必须在 RoleInstance.create 成功之后再 emit instance.created。
import { Subscription } from 'rxjs';
import { EventBus, bus } from '../events.js';
import { roster } from '../../roster/roster.js';

export function subscribeRoster(eventBus: EventBus = bus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.created').subscribe((e) => {
      try {
        roster.add({
          instanceId: e.instanceId,
          memberName: e.memberName,
          alias: e.memberName,
          scope: 'local',
          status: 'PENDING',
          address: `local:${e.instanceId}`,
          teamId: e.teamId,
          task: e.task,
        });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.add failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.activated').subscribe((e) => {
      try {
        roster.update(e.instanceId, { status: 'ACTIVE' });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.update ACTIVE failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.offline_requested').subscribe((e) => {
      try {
        roster.update(e.instanceId, { status: 'PENDING_OFFLINE' });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.update PENDING_OFFLINE failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.deleted').subscribe((e) => {
      try {
        if (roster.get(e.instanceId)) {
          roster.remove(e.instanceId);
        }
      } catch (err) {
        process.stderr.write(
          `[bus] roster.remove failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
