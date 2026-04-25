// Teams 领域 —— /api/panel/teams* facade；add/remove member 暂无 facade 占位。

import { panelGet, panelPost, panelDelete, panelPending, type ApiResult } from './client';

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
  return panelGet<Team[]>('/teams');
}

export function getTeam(id: string): Promise<ApiResult<TeamDetail>> {
  return panelGet<TeamDetail>(`/teams/${encodeURIComponent(id)}`);
}

export function createTeam(body: {
  name: string;
  leaderInstanceId: string;
  description?: string;
}): Promise<ApiResult<Team>> {
  return panelPost<Team>('/teams', body);
}

export function disbandTeam(id: string): Promise<ApiResult<null>> {
  return panelDelete<null>(`/teams/${encodeURIComponent(id)}`);
}

export function listTeamMembers(teamId: string): Promise<ApiResult<TeamMember[]>> {
  return panelGet<TeamMember[]>(`/teams/${encodeURIComponent(teamId)}/members`);
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
