// Team subscriber —— 维护 team 成员关系的级联一致性。
//
// 订阅清单：
//   - instance.offline_requested
//       成员 → removeMember + emit team.member_left(offline_requested)
//       leader → 级联下线所有成员 + disband + emit team.disbanded(leader_gone)
//   - instance.deleted
//       成员 → removeMember + emit team.member_left(instance_deleted)
//       leader → 用 role_instances.team_id 反查成员（CASCADE 已清 team_members）
//                → forceDeleteInstance 每个成员 + emit team.disbanded(leader_gone)
//   - instance.created（teamId != null）→ addMember + emit team.member_joined
//   - team.disbanded（reason='manual' 才处理）→ 级联下线所有成员
//   - team.member_left（reason='manual' 才处理）→ 级联下线被踢的成员
//
// 防循环：
//   - findByInstance 过滤 status='ACTIVE'，级联事件再进入时 team 已不活跃，返回 null 终止。
//   - team.disbanded / team.member_left 按 reason 分流，只处理主动触发的那一种。
//   - 成员走光不自动解散 —— leader 还在，可以再拉人。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { team } from '../../team/team.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { makeBase } from '../helpers.js';
import { getDb } from '../../db/connection.js';
import { cascadeOfflineMember, forceDeleteInstance } from './team-cascade.js';

// leader 被删后，用 role_instances.team_id 反查还活着的成员。
// 为什么不用 team.listMembers：instance.delete() 的 CASCADE 已清空 team_members 行。
// role_instances.team_id 是冗余列，不受 CASCADE 影响。
function listRemainingMembers(teamId: string, excludeId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT id FROM role_instances WHERE team_id = ? AND id != ?`)
    .all(teamId, excludeId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function subscribeTeam(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.offline_requested').subscribe((e) => {
      try {
        // 用 RoleInstance 查 teamId/isLeader 而不是 team.findByInstance：
        // leader 可能没 addMember 到 team_members 里（team.create 不自动加），
        // 但 role_instances.team_id 在 addMember 之外由 API 层或 leader 创建时已设好。
        // 注意：如果 role_instances.team_id 也没设（leader create team 时 DAO 不回写），
        // 这里仍会查不到 — fallback 到 team.findActiveByLeader。
        const inst = RoleInstance.findById(e.instanceId);
        if (!inst) return;

        let teamRow = inst.teamId ? team.findById(inst.teamId) : null;
        if (!teamRow && inst.isLeader) {
          teamRow = team.findActiveByLeader(e.instanceId);
        }
        if (!teamRow || teamRow.status !== 'ACTIVE') return;

        const isLeader = teamRow.leaderInstanceId === e.instanceId;

        if (isLeader) {
          // leader 下线 → 先级联所有成员，再 disband。
          // listMembers 在 team 还 ACTIVE 时调用，成员行还在。
          const members = team.listMembers(teamRow.id);
          for (const m of members) {
            if (m.instanceId === e.instanceId) continue;
            cascadeOfflineMember(eventBus, m.instanceId, e.instanceId);
          }
          team.disband(teamRow.id);
          eventBus.emit({
            ...makeBase('team.disbanded', 'bus/team.subscriber'),
            teamId: teamRow.id,
            reason: 'leader_gone',
          });
          return;
        }

        // 普通成员：从 team 移除。leader 还在，不自动解散空 team。
        const removed = team.removeMember(teamRow.id, e.instanceId);
        if (removed) {
          eventBus.emit({
            ...makeBase('team.member_left', 'bus/team.subscriber'),
            teamId: teamRow.id,
            instanceId: e.instanceId,
            reason: 'offline_requested',
          });
        }
      } catch (err) {
        process.stderr.write(
          `[bus/team] instance.offline_requested handler failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.deleted').subscribe((e) => {
      try {
        // 用 emit 端带来的 teamId / isLeader 快照，不再 findByInstance
        // （CASCADE 已清空 team_members，查不到）。
        if (!e.teamId) return;

        if (e.isLeader) {
          // leader 被删 → CASCADE 已清 teams / team_members。
          // 用 role_instances.team_id 反查还活着的成员，force delete。
          const memberIds = listRemainingMembers(e.teamId, e.instanceId);
          for (const id of memberIds) {
            forceDeleteInstance(eventBus, id);
          }
          eventBus.emit({
            ...makeBase('team.disbanded', 'bus/team.subscriber'),
            teamId: e.teamId,
            reason: 'leader_gone',
          });
          return;
        }

        // 普通成员：清 team_members 行（CASCADE 已清也 OK，幂等）。
        // 无条件 emit team.member_left — CASCADE 已经替我们删了行，
        // 语义上成员确实离开，不依赖 removeMember 返回值。
        team.removeMember(e.teamId, e.instanceId);
        eventBus.emit({
          ...makeBase('team.member_left', 'bus/team.subscriber'),
          teamId: e.teamId,
          instanceId: e.instanceId,
          reason: 'instance_deleted',
        });
        // 成员走光不解散 — leader 还在，可以再拉人。
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

  sub.add(
    eventBus.on('team.disbanded').subscribe((e) => {
      // 只处理 API 手动解散。leader_gone 的级联已在 instance.* handler 里做过，不重复。
      if (e.reason !== 'manual') return;
      try {
        const members = team.listMembers(e.teamId);
        for (const m of members) {
          cascadeOfflineMember(eventBus, m.instanceId, 'team-disband');
        }
      } catch (err) {
        process.stderr.write(
          `[bus/team] team.disbanded handler failed for ${e.teamId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('team.member_left').subscribe((e) => {
      // 只处理 API 手动踢人。其他 reason 的 member_left 都是级联产物，下线动作已在上游做过。
      if (e.reason !== 'manual') return;
      try {
        cascadeOfflineMember(eventBus, e.instanceId, 'team-kick');
      } catch (err) {
        process.stderr.write(
          `[bus/team] team.member_left handler failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
