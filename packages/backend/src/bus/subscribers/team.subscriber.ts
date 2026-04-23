// Team subscriber —— 维护 team 成员关系的级联一致性。
//   - instance.deleted → removeMember + emit team.member_left(instance_deleted)
//     若删的是 leader，teams 表由 ON DELETE CASCADE 自动消失，emit team.disbanded(leader_gone)
//     成员全走光不解散 — leader 还在，可以再拉人
//   - instance.created（teamId != null）→ 尝试 addMember + emit team.member_joined
//     team 可能还不存在（leader 先 create instance、后 create team），失败吞掉
//
// team 解散只有两种触发：leader 下线 / 手动 API disband。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { team } from '../../team/team.js';
import { makeBase } from '../helpers.js';

export function subscribeTeam(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.deleted').subscribe((e) => {
      try {
        const t = team.findByInstance(e.instanceId);
        if (!t) return;

        const isLeader = t.leaderInstanceId === e.instanceId;

        const removed = team.removeMember(t.id, e.instanceId);
        if (removed) {
          eventBus.emit({
            ...makeBase('team.member_left', 'bus/team.subscriber'),
            teamId: t.id,
            instanceId: e.instanceId,
            reason: 'instance_deleted',
          });
        }

        if (isLeader) {
          // leader_instance_id 上的 ON DELETE CASCADE 会物理删 team 行；
          // 这里不再 disband（行可能已不存在），仅 emit 语义事件给上层。
          eventBus.emit({
            ...makeBase('team.disbanded', 'bus/team.subscriber'),
            teamId: t.id,
            reason: 'leader_gone',
          });
          return;
        }

        // 成员全走光不解散 — leader 还在，可以再拉人。
      } catch (err) {
        process.stderr.write(
          `[bus/team] instance.deleted handler failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.created').subscribe((e) => {
      if (!e.teamId) return;
      try {
        team.addMember(e.teamId, e.instanceId, null);
        eventBus.emit({
          ...makeBase('team.member_joined', 'bus/team.subscriber'),
          teamId: e.teamId,
          instanceId: e.instanceId,
          roleInTeam: null,
        });
      } catch {
        // team 可能还不存在（leader 的 team 在 instance 创建后才建），吞掉。
      }
    }),
  );

  return sub;
}
