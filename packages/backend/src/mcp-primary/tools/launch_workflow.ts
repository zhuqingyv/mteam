// Phase 5 W2 · mteam-primary · launch_workflow
// 调 HTTP POST /api/workflows/:name/launch，和 create_leader 一样只做参数转发。
import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const launchWorkflowSchema = {
  name: 'launch_workflow',
  description:
    '按既定协作流程一键组建团队：自动拉起负责人、招募成员并分配目标。' +
    '内置流程包括 code-review 代码评审、fullstack-team 全栈团队、bug-fix 改 bug、tech-research 技术调研、doc-writing 文档撰写。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: {
        type: 'string',
        description: '协作流程名（如 code-review）。',
      },
      projectName: { type: 'string', description: '团队/项目的显示名。' },
      goal: { type: 'string', description: '本次协作的目标描述。' },
      deadline: { type: 'number', description: '截止时间（可选，绝对毫秒时间戳）。' },
    },
    required: ['templateName', 'projectName', 'goal'],
    additionalProperties: false,
  },
};

interface LaunchArgs {
  templateName?: unknown;
  projectName?: unknown;
  goal?: unknown;
  deadline?: unknown;
}

export async function runLaunchWorkflow(
  env: PrimaryMcpEnv,
  args: LaunchArgs,
): Promise<unknown> {
  const templateName = typeof args.templateName === 'string' ? args.templateName : '';
  const projectName = typeof args.projectName === 'string' ? args.projectName : '';
  const goal = typeof args.goal === 'string' ? args.goal : '';
  if (!templateName) return { error: 'templateName is required' };
  if (!projectName) return { error: 'projectName is required' };
  if (!goal) return { error: 'goal is required' };
  const deadline = typeof args.deadline === 'number' ? args.deadline : undefined;

  const res = await httpJson<{
    teamId: string; leaderId: string;
    members: Array<{ templateName: string; instanceId: string }>;
  }>(
    `${env.hubUrl}/api/workflows/${encodeURIComponent(templateName)}/launch`,
    {
      method: 'POST',
      body: JSON.stringify({ projectName, goal, ...(deadline !== undefined ? { deadline } : {}) }),
    },
  );
  if (!res.ok || !res.body) {
    return { error: res.error ?? `launch failed (HTTP ${res.status})` };
  }
  return res.body;
}
