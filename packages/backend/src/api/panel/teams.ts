// Team HTTP 接口：团队和成员关系的 CRUD。
// handler 发主动事件（team.created/disbanded/member_joined/member_left），
// 级联响应（instance 被删时自动清理成员/解散空 team）由 bus/subscribers/team.subscriber.ts 处理。
import { team } from '../../team/team.js';
import { RoleInstance } from '../../domain/role-instance.js';
import { bus } from '../../bus/index.js';
import { makeBase, newCorrelationId } from '../../bus/helpers.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function handleListTeams(): ApiResponse {
  return { status: 200, body: team.listAll() };
}

export function handleGetTeam(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  const members = team.listMembers(teamId);
  return { status: 200, body: { ...t, members } };
}

export function handleCreateTeam(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const name = str(body.name);
  const leaderInstanceId = str(body.leaderInstanceId);
  if (!name || name.length < 1 || name.length > 64) {
    return errRes(400, 'name is required (1~64 chars)');
  }
  if (!leaderInstanceId) return errRes(400, 'leaderInstanceId is required');

  try {
    const created = team.create({
      name,
      leaderInstanceId,
      description: str(body.description) ?? '',
    });
    bus.emit({
      ...makeBase('team.created', 'api/panel/teams', newCorrelationId()),
      teamId: created.id,
      name: created.name,
      leaderInstanceId: created.leaderInstanceId,
    });
    return { status: 201, body: created };
  } catch (e) {
    const msg = (e as Error).message;
    // DAO 层（team.create）遇到已存在 ACTIVE team 时抛 "leader '...' already has active team '...'"
    if (msg.includes('already has active team')) return errRes(409, msg);
    return errRes(400, msg);
  }
}

export function handleDisbandTeam(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  if (t.status === 'DISBANDED') return errRes(409, `team '${teamId}' already disbanded`);
  team.disband(teamId);
  bus.emit({
    ...makeBase('team.disbanded', 'api/panel/teams'),
    teamId,
    reason: 'manual',
  });
  return { status: 204, body: null };
}

export function handleListMembers(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  return { status: 200, body: team.listMembers(teamId) };
}

export function handleAddMember(teamId: string, body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const instanceId = str(body.instanceId);
  if (!instanceId) return errRes(400, 'instanceId is required');
  const roleInTeam = 'roleInTeam' in body ? str(body.roleInTeam) : null;

  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  if (t.status !== 'ACTIVE') return errRes(409, `team '${teamId}' is disbanded`);

  try {
    team.addMember(teamId, instanceId, roleInTeam);
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
  bus.emit({
    ...makeBase('team.member_joined', 'api/panel/teams'),
    teamId,
    instanceId,
    roleInTeam,
  });
  return { status: 201, body: { teamId, instanceId, roleInTeam } };
}

// 按 instanceId 反查所属 ACTIVE team，并返回 enrich 后的成员列表。
// 成员条目带 memberName / status / isLeader，供 list_members 工具直接返回。
export function handleGetTeamByInstance(instanceId: string): ApiResponse {
  const t = team.findByInstance(instanceId);
  if (!t) return errRes(404, `instance '${instanceId}' is not in any active team`);
  const rows = team.listMembers(t.id);
  const members = rows.map((m) => {
    const inst = RoleInstance.findById(m.instanceId);
    return {
      instanceId: m.instanceId,
      memberName: inst?.memberName ?? null,
      status: inst?.status ?? null,
      isLeader: inst?.isLeader ?? false,
      roleInTeam: m.roleInTeam,
      joinedAt: m.joinedAt,
    };
  });
  return {
    status: 200,
    body: {
      teamId: t.id,
      teamName: t.name,
      leaderInstanceId: t.leaderInstanceId,
      members,
    },
  };
}

export function handleRemoveMember(teamId: string, instanceId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  const removed = team.removeMember(teamId, instanceId);
  if (removed) {
    bus.emit({
      ...makeBase('team.member_left', 'api/panel/teams'),
      teamId,
      instanceId,
      reason: 'manual',
    });
  }
  return { status: 204, body: null };
}
