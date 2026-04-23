export type TeamStatus = 'ACTIVE' | 'DISBANDED';

// 对外暴露的 team 记录（列名映射为 camelCase）。
export interface TeamRow {
  id: string;
  name: string;
  leaderInstanceId: string;
  description: string;
  status: TeamStatus;
  createdAt: string;
  disbandedAt: string | null;
}

// 对外暴露的 team_members 记录。
export interface TeamMemberRow {
  id: number;
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
  joinedAt: string;
}

// create(input) 入参。id 不传则内部 randomUUID()。
export interface CreateTeamInput {
  id?: string;
  name: string;
  leaderInstanceId: string;
  description?: string;
}

// 带成员列表的 team 视图（HTTP GET /api/teams/:id 用）。
export interface TeamWithMembers extends TeamRow {
  members: TeamMemberRow[];
}
