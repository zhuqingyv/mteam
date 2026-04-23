import { httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const listMembersSchema = {
  name: 'list_members',
  description:
    "List all members of the caller's team with their memberName, status, and role.",
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};

interface ListMembersBody {
  teamId: string;
  teamName: string;
  leaderInstanceId: string;
  members: Array<{
    instanceId: string;
    memberName: string | null;
    status: string | null;
    isLeader: boolean;
    roleInTeam: string | null;
    joinedAt: string;
  }>;
}

export async function runListMembers(env: MteamEnv): Promise<unknown> {
  const url = `${env.hubUrl}/api/teams/by-instance/${encodeURIComponent(env.instanceId)}`;
  const res = await httpJson<ListMembersBody>(url, { method: 'GET' });
  if (!res.ok) {
    return { error: res.error ?? `list_members failed (HTTP ${res.status})` };
  }
  return res.body ?? { teamId: '', teamName: '', leaderInstanceId: '', members: [] };
}
