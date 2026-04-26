// Teams 领域 —— /api/panel/teams* facade。
import { panelGet, panelPost, panelDelete, type ApiResult } from './client';

export interface TeamRow {
  id: string; name: string; leaderInstanceId: string; description: string;
  status: 'ACTIVE' | 'DISBANDED'; createdAt: string; disbandedAt: string | null;
}

export interface TeamMemberRow {
  id: number; teamId: string; instanceId: string;
  roleInTeam: string | null; joinedAt: string;
}

export interface TeamWithMembers extends TeamRow { members: TeamMemberRow[] }

export interface TeamByInstanceMember {
  instanceId: string; memberName: string | null; status: string | null;
  isLeader: boolean; roleInTeam: string | null; joinedAt: string;
}

export interface TeamByInstance {
  teamId: string; teamName: string; leaderInstanceId: string;
  members: TeamByInstanceMember[];
}

export const listTeams = () => panelGet<TeamRow[]>('/teams');

export const getTeam = (id: string) =>
  panelGet<TeamWithMembers>(`/teams/${encodeURIComponent(id)}`);

export function createTeam(
  body: { name: string; leaderInstanceId: string; description?: string },
): Promise<ApiResult<TeamRow>> {
  return panelPost<TeamRow>('/teams', body);
}

export const disbandTeam = (id: string) =>
  panelPost<null>(`/teams/${encodeURIComponent(id)}/disband`);

export const listTeamMembers = (teamId: string) =>
  panelGet<TeamMemberRow[]>(`/teams/${encodeURIComponent(teamId)}/members`);

export function addTeamMember(
  teamId: string,
  body: { instanceId: string; roleInTeam?: string },
): Promise<ApiResult<{ teamId: string; instanceId: string; roleInTeam: string | null }>> {
  return panelPost(`/teams/${encodeURIComponent(teamId)}/members`, body);
}

export function removeTeamMember(teamId: string, instanceId: string): Promise<ApiResult<null>> {
  const e = encodeURIComponent;
  return panelDelete<null>(`/teams/${e(teamId)}/members/${e(instanceId)}`);
}

export const getTeamByInstance = (instanceId: string) =>
  panelGet<TeamByInstance>(`/teams/by-instance/${encodeURIComponent(instanceId)}`);
