// Comm notify subscriber —— 补全旧架构遗漏的副作用：
// 1) leader 批准下线（instance.offline_requested）→ 给目标成员发 deactivate 系统消息。
// 2) member 激活（instance.activated）→ 给其 leader 发 member_activated 系统消息。
//
// 走 CommRouter.dispatch，from=local:system，to=local:<instanceId>，
// payload 带 kind=system + action 字段，便于接收端按 action 分派。
// leader 的 instanceId 存在 role_instances.leader_name（add_member 写入时就是 env.instanceId）。
import { Subscription } from 'rxjs';
import { EventBus, bus } from '../events.js';
import type { CommRouter } from '../../comm/router.js';
import type { Message, Address } from '../../comm/types.js';
import { RoleInstance } from '../../domain/role-instance.js';

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

  sub.add(
    eventBus.on('instance.activated').subscribe((e) => {
      try {
        const inst = RoleInstance.findById(e.instanceId);
        if (!inst) return;
        // leader 自己激活不需要通知（没有上级）；member 没填 leaderName 也无从通知。
        if (inst.isLeader) return;
        if (!inst.leaderName) return;

        const msg: Message = {
          type: 'message',
          id: `sys-activated-${e.instanceId}-${Date.now()}`,
          from: 'local:system' as Address,
          to: `local:${inst.leaderName}` as Address,
          payload: {
            kind: 'system',
            summary: `${inst.memberName} 上线了`,
            action: 'member_activated',
            instanceId: e.instanceId,
            memberName: inst.memberName,
          },
          ts: e.ts,
        };
        router.dispatch(msg);
      } catch (err) {
        process.stderr.write(
          `[bus] comm-notify activate dispatch failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
