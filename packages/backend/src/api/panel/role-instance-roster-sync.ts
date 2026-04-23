// role-instance 生命周期对 roster 的同步辅助。
// 所有写操作都吞异常（记日志），避免因 roster 一时不一致把主流程弄崩。
import { roster } from '../../roster/roster.js';
import type { RoleInstance } from '../../domain/role-instance.js';

// 新实例入名册；address 统一 local:<id>。
export function rosterAddInstance(instance: RoleInstance): void {
  try {
    roster.add({
      instanceId: instance.id,
      memberName: instance.memberName,
      alias: instance.memberName,
      scope: 'local',
      status: instance.status,
      address: `local:${instance.id}`,
      teamId: instance.teamId,
      task: instance.task,
    });
  } catch (err) {
    process.stderr.write(
      `[v2] roster.add failed for ${instance.id}: ${(err as Error).message}\n`,
    );
  }
}

// 同步状态字段，供 activate / request-offline 调用。
export function rosterUpdateStatus(instanceId: string, status: string): void {
  try {
    roster.update(instanceId, { status });
  } catch (err) {
    process.stderr.write(
      `[v2] roster.update status=${status} failed for ${instanceId}: ${(err as Error).message}\n`,
    );
  }
}

// 删除实例时清名册；如果不存在就跳过，避免 remove 抛错。
export function rosterRemoveIfPresent(instanceId: string): void {
  try {
    if (roster.get(instanceId)) {
      roster.remove(instanceId);
    }
  } catch (err) {
    process.stderr.write(
      `[v2] roster.remove failed for ${instanceId}: ${(err as Error).message}\n`,
    );
  }
}
