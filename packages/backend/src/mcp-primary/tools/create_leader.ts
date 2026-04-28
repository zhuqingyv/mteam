import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const createLeaderSchema = {
  name: 'create_leader',
  description:
    'Create a Leader role instance, a new team, and add the Leader as a team member. ' +
    'templateName MUST be an existing role template name — do NOT invent names. ' +
    'If unsure, call search_settings({q:"templates"}) first or query GET /api/panel/templates. ' +
    'Built-in templates include: frontend-dev, backend-dev, fullstack-dev, qa-engineer, ' +
    'tech-architect, code-reviewer, devops-engineer, ui-ux-designer, tech-writer, ' +
    'perf-optimizer, product-manager. ' +
    'Returns { instanceId, teamId, memberName, teamName } on success.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: {
        type: 'string',
        description:
          'Existing role template name (e.g. frontend-dev). Use search_settings if unsure — never invent.',
      },
      memberName: { type: 'string', description: 'Display name for the Leader.' },
      teamName: { type: 'string', description: 'Team name.' },
      description: { type: 'string', description: 'Optional team description.' },
      task: { type: 'string', description: 'Optional initial task for the Leader.' },
    },
    required: ['templateName', 'memberName', 'teamName'],
    additionalProperties: false,
  },
};

interface CreateLeaderArgs {
  templateName?: unknown;
  memberName?: unknown;
  teamName?: unknown;
  description?: unknown;
  task?: unknown;
}

export async function runCreateLeader(
  env: PrimaryMcpEnv,
  args: CreateLeaderArgs,
): Promise<unknown> {
  const templateName = typeof args.templateName === 'string' ? args.templateName : '';
  const memberName = typeof args.memberName === 'string' ? args.memberName : '';
  const teamName = typeof args.teamName === 'string' ? args.teamName : '';
  if (!templateName) return { error: 'templateName is required' };
  if (!memberName) return { error: 'memberName is required' };
  if (!teamName) return { error: 'teamName is required' };
  const description = typeof args.description === 'string' ? args.description : null;
  const task = typeof args.task === 'string' ? args.task : null;

  // 1) 创建 leader role instance
  const createRes = await httpJson<{ id: string }>(
    `${env.hubUrl}/api/role-instances`,
    {
      method: 'POST',
      body: JSON.stringify({ templateName, memberName, isLeader: true, task }),
    },
  );
  if (!createRes.ok || !createRes.body?.id) {
    const errMsg = createRes.error ?? `create leader failed (HTTP ${createRes.status})`;
    // 模板不存在时附上可用列表，避免主 Agent 再次瞎猜名字。
    if (createRes.status === 404 && /template '.*' not found/.test(errMsg)) {
      const tplRes = await httpJson<Array<{ name: string }>>(
        `${env.hubUrl}/api/panel/templates`,
        { method: 'GET' },
      );
      const availableTemplates = Array.isArray(tplRes.body)
        ? tplRes.body.map((t) => t.name).filter((n): n is string => typeof n === 'string')
        : [];
      return { error: errMsg, availableTemplates };
    }
    return { error: errMsg };
  }
  const instanceId = createRes.body.id;

  // 2) 建团队，leader 指向刚创建的实例
  const teamRes = await httpJson<{ id: string }>(
    `${env.hubUrl}/api/teams`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: teamName,
        leaderInstanceId: instanceId,
        ...(description ? { description } : {}),
      }),
    },
  );
  if (!teamRes.ok || !teamRes.body?.id) {
    return {
      error: teamRes.error ?? `create team failed (HTTP ${teamRes.status})`,
      instanceId,
    };
  }
  const teamId = teamRes.body.id;

  // 3) 把 leader 加入 team_members（与现有 UI 流程保持一致）
  const joinRes = await httpJson(
    `${env.hubUrl}/api/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ instanceId }),
    },
  );
  if (!joinRes.ok) {
    return {
      error: joinRes.error ?? `add leader to team failed (HTTP ${joinRes.status})`,
      instanceId,
      teamId,
    };
  }

  return { instanceId, teamId, memberName, teamName };
}
