import { httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const addMemberSchema = {
  name: 'add_member',
  description:
    'Leader-only. Create a member role instance and add it to the caller leader\'s team.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: { type: 'string', description: 'Role template name.' },
      memberName: { type: 'string', description: 'Member name (unique within the team).' },
      task: { type: 'string', description: 'Optional task assigned to the new member.' },
      roleInTeam: { type: 'string', description: 'Optional role description inside the team.' },
    },
    required: ['templateName', 'memberName'],
    additionalProperties: false,
  },
};

interface InstanceListItem {
  id: string;
  isLeader: boolean;
  teamId: string | null;
  memberName: string;
}

async function findSelfTeamId(env: MteamEnv): Promise<
  { ok: true; teamId: string } | { ok: false; error: string }
> {
  const res = await httpJson<InstanceListItem[]>(
    `${env.hubUrl}/api/role-instances`,
    { method: 'GET' },
  );
  if (!res.ok) return { ok: false, error: res.error ?? `list instances failed (HTTP ${res.status})` };
  const list = Array.isArray(res.body) ? res.body : [];
  const self = list.find((r) => r.id === env.instanceId);
  if (!self) return { ok: false, error: `self instance '${env.instanceId}' not found` };
  if (!self.isLeader) return { ok: false, error: 'add_member is leader-only' };
  if (!self.teamId) return { ok: false, error: 'leader has no active team' };
  return { ok: true, teamId: self.teamId };
}

export async function runAddMember(
  env: MteamEnv,
  args: { templateName?: unknown; memberName?: unknown; task?: unknown; roleInTeam?: unknown },
): Promise<unknown> {
  const templateName = typeof args.templateName === 'string' ? args.templateName : '';
  const memberName = typeof args.memberName === 'string' ? args.memberName : '';
  if (!templateName) return { error: 'templateName is required' };
  if (!memberName) return { error: 'memberName is required' };
  const task = typeof args.task === 'string' ? args.task : null;
  const roleInTeam = typeof args.roleInTeam === 'string' ? args.roleInTeam : null;

  const selfRes = await findSelfTeamId(env);
  if (!selfRes.ok) return { error: selfRes.error };
  const teamId = selfRes.teamId;

  const createRes = await httpJson<{ id: string }>(
    `${env.hubUrl}/api/role-instances`,
    {
      method: 'POST',
      body: JSON.stringify({
        templateName,
        memberName,
        isLeader: false,
        task,
        leaderName: env.instanceId,
      }),
    },
  );
  if (!createRes.ok || !createRes.body?.id) {
    return { error: createRes.error ?? `create instance failed (HTTP ${createRes.status})` };
  }
  const instanceId = createRes.body.id;

  const joinRes = await httpJson(
    `${env.hubUrl}/api/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ instanceId, roleInTeam }),
    },
  );
  if (!joinRes.ok) {
    return {
      error: joinRes.error ?? `join team failed (HTTP ${joinRes.status})`,
      instanceId,
      teamId,
    };
  }

  return { instanceId, memberName, teamId };
}
