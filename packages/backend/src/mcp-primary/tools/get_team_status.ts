// mteam-primary · get_team_status
// 主 Agent 查一个团队的健康度。HTTP 组合：
//   1) GET /api/teams/:teamId         — 拿 teamName + leaderInstanceId + 裸成员列表
//   2) GET /api/role-instances        — 拿全量 memberName/status/task 用于 enrich
// 不 mock、纯读、纯 HTTP。
import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const getTeamStatusSchema = {
  name: 'get_team_status',
  description:
    '查看某个团队的当前状态：团队名、负责人、所有成员（含在做什么、忙不忙）以及人数。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      teamId: { type: 'string', description: '团队的 id（可从 list_addresses 或 launch_workflow 的返回结果里拿到）。' },
    },
    required: ['teamId'],
    additionalProperties: false,
  },
};

interface RawTeam {
  id: string;
  name: string;
  leaderInstanceId: string;
  members: Array<{ instanceId: string }>;
}

interface RawInstance {
  id: string;
  memberName: string;
  status: string;
  task: string | null;
}

interface MemberView {
  name: string;
  status: string;
  task?: string;
}

export async function runGetTeamStatus(
  env: PrimaryMcpEnv,
  args: { teamId?: unknown },
): Promise<unknown> {
  const teamId = typeof args.teamId === 'string' ? args.teamId.trim() : '';
  if (!teamId) return { error: 'teamId is required' };

  const teamRes = await httpJson<RawTeam>(
    `${env.hubUrl}/api/teams/${encodeURIComponent(teamId)}`,
    { method: 'GET' },
  );
  if (!teamRes.ok || !teamRes.body) {
    return { error: teamRes.error ?? `get_team_status failed (HTTP ${teamRes.status})` };
  }
  const t = teamRes.body;

  const instRes = await httpJson<RawInstance[]>(`${env.hubUrl}/api/role-instances`, { method: 'GET' });
  if (!instRes.ok || !instRes.body) {
    return { error: instRes.error ?? `list instances failed (HTTP ${instRes.status})` };
  }
  const byId = new Map<string, RawInstance>();
  for (const i of instRes.body) byId.set(i.id, i);

  const view = (instanceId: string): MemberView => {
    const i = byId.get(instanceId);
    const base: MemberView = { name: i?.memberName ?? instanceId, status: i?.status ?? 'UNKNOWN' };
    if (i?.task) base.task = i.task;
    return base;
  };

  const leader = view(t.leaderInstanceId);
  const members = t.members
    .filter((m) => m.instanceId !== t.leaderInstanceId)
    .map((m) => view(m.instanceId));

  return {
    teamName: t.name,
    leader,
    members,
    memberCount: t.members.length,
  };
}
