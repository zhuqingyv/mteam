// mteam-primary · list_addresses
// 主 Agent 通讯录：聚合 role-instances + teams，输出带 address 的 leader/member 列表。
// 纯 HTTP 读取，不改状态。
import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const listAddressesSchema = {
  name: 'list_addresses',
  description:
    'Primary Agent tool: list all agent addresses. Filter by scope (all/leaders/members) and/or teamId.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['all', 'leaders', 'members'], description: 'Filter by role kind; defaults to "all".' },
      teamId: { type: 'string', description: 'Optional team id filter.' },
    },
    additionalProperties: false,
  },
};

type Scope = 'all' | 'leaders' | 'members';

interface RoleInstanceRow {
  id: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  status: string;
}

interface TeamRow {
  id: string;
  leaderInstanceId: string;
  status: string;
}

export interface AddressEntry {
  address: string;
  kind: 'leader' | 'member';
  displayName: string;
  instanceId: string;
  teamId: string | null;
  status: string;
}

function normalizeScope(v: unknown): Scope {
  if (v === 'leaders' || v === 'members') return v;
  return 'all';
}

export async function runListAddresses(
  env: PrimaryMcpEnv,
  args: { scope?: unknown; teamId?: unknown },
): Promise<{ entries: AddressEntry[]; total: number } | { error: string }> {
  const scope = normalizeScope(args.scope);
  const teamIdFilter = typeof args.teamId === 'string' && args.teamId.length > 0 ? args.teamId : null;

  const instRes = await httpJson<RoleInstanceRow[]>(`${env.hubUrl}/api/role-instances`, { method: 'GET' });
  if (!instRes.ok) return { error: `list role-instances failed: ${instRes.error ?? `HTTP ${instRes.status}`}` };

  const teamRes = await httpJson<TeamRow[]>(`${env.hubUrl}/api/teams`, { method: 'GET' });
  if (!teamRes.ok) return { error: `list teams failed: ${teamRes.error ?? `HTTP ${teamRes.status}`}` };

  const instances = Array.isArray(instRes.body) ? instRes.body : [];
  const teams = Array.isArray(teamRes.body) ? teamRes.body : [];

  // teamId by leader instance id, based on ACTIVE teams. role_instances.teamId 已冗余维护，
  // 但 leader 自己的 teamId 可能为 null（team 只维护 member 关系）；用 teams 表兜底映射 leader→team。
  const leaderToTeamId = new Map<string, string>();
  for (const t of teams) {
    if (t.status === 'ACTIVE' && t.leaderInstanceId) {
      leaderToTeamId.set(t.leaderInstanceId, t.id);
    }
  }

  const entries: AddressEntry[] = [];
  for (const r of instances) {
    const kind: 'leader' | 'member' = r.isLeader ? 'leader' : 'member';
    if (scope === 'leaders' && kind !== 'leader') continue;
    if (scope === 'members' && kind !== 'member') continue;
    const teamId = r.teamId ?? leaderToTeamId.get(r.id) ?? null;
    if (teamIdFilter && teamId !== teamIdFilter) continue;
    entries.push({
      address: `local:${r.id}`,
      kind,
      displayName: r.memberName,
      instanceId: r.id,
      teamId,
      status: r.status,
    });
  }

  return { entries, total: entries.length };
}
