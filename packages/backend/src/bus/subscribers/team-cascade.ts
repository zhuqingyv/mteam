// Team 级联下线辅助函数。
// 被 team.subscriber 调用，用来把"某个 instance 该下线"翻译成：
//   ACTIVE         → requestOffline（优雅下线，driver 还跑，给成员收尾窗口）
//   PENDING        → delete（还没激活，没有"优雅"必要，直接清理）
//   PENDING_OFFLINE→ delete（已在下线流程，直接完成）
//   其他状态       → 跳过（已 DELETED / 未知状态，不乱动）
// 每个动作都补发对应 bus 事件，让 member-driver / roster / ws subscriber 正常联动。
import { RoleInstance } from '../../domain/role-instance.js';
import type { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';

// 优雅级联：ACTIVE 走 requestOffline；PENDING/PENDING_OFFLINE 直接 force delete。
// 用于 leader request_offline / manual disband 场景。
export function cascadeOfflineMember(
  eventBus: EventBus,
  instanceId: string,
  actor: string,
): void {
  const inst = RoleInstance.findById(instanceId);
  if (!inst) return;

  if (inst.status === 'ACTIVE') {
    inst.requestOffline(actor);
    eventBus.emit({
      ...makeBase('instance.offline_requested', 'bus/team.subscriber'),
      instanceId,
      requestedBy: actor,
    });
    return;
  }

  if (inst.status === 'PENDING' || inst.status === 'PENDING_OFFLINE') {
    forceDeleteInstance(eventBus, instanceId);
  }
  // 其他状态（DELETED 等）不动。
}

// 强制删除：不看状态直接 delete + emit instance.deleted(force=true)。
// 用于 leader deleted 场景（崩溃/强制语义，立即释放资源）。
export function forceDeleteInstance(
  eventBus: EventBus,
  instanceId: string,
): void {
  const inst = RoleInstance.findById(instanceId);
  if (!inst) return;
  const previousStatus = inst.status;
  const teamId = inst.teamId;
  const isLeader = inst.isLeader;
  inst.delete();
  eventBus.emit({
    ...makeBase('instance.deleted', 'bus/team.subscriber'),
    instanceId,
    previousStatus,
    force: true,
    teamId,
    isLeader,
  });
}
