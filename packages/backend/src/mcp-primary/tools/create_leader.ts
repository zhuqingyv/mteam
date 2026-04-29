import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const createLeaderSchema = {
  name: 'create_leader',
  description:
    '为任务安排一个负责人（Leader），自动组建团队。负责人会根据任务需要自行招募团队成员并分配工作。' +
    'templateName 是负责人的专业岗位（如 tech-architect 架构师、frontend-dev 前端开发），' +
    '用 search_settings({q:"templates"}) 可查看所有可用岗位。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: {
        type: 'string',
        description:
          '负责人的专业岗位名（如 frontend-dev 前端开发）。不确定可先用 search_settings 查询，不要自己编造。',
      },
      memberName: { type: 'string', description: '负责人的显示名（用于团队内称呼）。' },
      teamName: { type: 'string', description: '团队名称。' },
      description: { type: 'string', description: '团队简介（可选）。' },
      task: { type: 'string', description: '交给负责人的初始任务（可选）。' },
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
    };
  }

  return { memberName, teamName };
}
