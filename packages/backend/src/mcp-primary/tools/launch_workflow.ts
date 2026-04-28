// Phase 5 W2 · mteam-primary · launch_workflow
// 调 HTTP POST /api/workflows/:name/launch，和 create_leader 一样只做参数转发。
import { httpJson } from '../../mcp/http-client.js';
import type { PrimaryMcpEnv } from '../config.js';

export const launchWorkflowSchema = {
  name: 'launch_workflow',
  description:
    'Launch a workflow template: creates a team with leader + members + assigns goal. ' +
    'Built-in templates include: code-review, fullstack-team, bug-fix, tech-research, doc-writing. ' +
    'Returns { teamId, leaderId, members: [...] } on success.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: {
        type: 'string',
        description: 'Workflow template name (e.g. code-review).',
      },
      projectName: { type: 'string', description: 'Team / project display name.' },
      goal: { type: 'string', description: 'The goal used to render {{goal}} in role tasks.' },
      deadline: { type: 'number', description: 'Optional absolute ms timestamp.' },
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
