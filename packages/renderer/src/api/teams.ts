// Teams 领域 —— [待 D6]
//
// 服务端现有端点挂在顶级 /api/teams（非 /api/panel/），前端硬门禁禁止直连。
// D6 facade 落地前，所有调用返回统一 D6 pending 错误，面板走 UI 骨架 + 空态。
//
// 未来服务端 facade 映射参考（等 D6 合同确定后再实现真实调用）：
//   listTeams        → GET  /api/panel/teams
//   getTeam          → GET  /api/panel/teams/:id
//   createTeam       → POST /api/panel/teams
//   disbandTeam      → POST /api/panel/teams/:id/disband
//   listTeamMembers  → GET  /api/panel/teams/:id/members
//   addTeamMember    → POST /api/panel/teams/:id/members
//   removeTeamMember → DELETE /api/panel/teams/:id/members/:instanceId

import { panelPending, type ApiResult } from './client';

export interface Team {
  id: string;
  name: string;
  leaderInstanceId: string;
  status: 'ACTIVE' | 'DISBANDED';
  description?: string;
}

export interface TeamMember {
  instanceId: string;
  roleInTeam: string | null;
  joinedAt: string;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
}

export function listTeams(): Promise<ApiResult<Team[]>> {
  return panelPending<Team[]>('teams.list');
}

export function getTeam(_id: string): Promise<ApiResult<TeamDetail>> {
  return panelPending<TeamDetail>('teams.get');
}

export function createTeam(_body: {
  name: string;
  leaderInstanceId: string;
  description?: string;
}): Promise<ApiResult<Team>> {
  return panelPending<Team>('teams.create');
}

export function disbandTeam(_id: string): Promise<ApiResult<null>> {
  return panelPending<null>('teams.disband');
}

export function listTeamMembers(_teamId: string): Promise<ApiResult<TeamMember[]>> {
  return panelPending<TeamMember[]>('teams.listMembers');
}

export function addTeamMember(
  _teamId: string,
  _body: { instanceId: string; roleInTeam?: string },
): Promise<ApiResult<TeamMember>> {
  return panelPending<TeamMember>('teams.addMember');
}

export function removeTeamMember(
  _teamId: string,
  _instanceId: string,
): Promise<ApiResult<null>> {
  return panelPending<null>('teams.removeMember');
}
