import type { PrimaryMcpEnv } from '../config.js';
import { createLeaderSchema, runCreateLeader } from './create_leader.js';
import { sendToAgentSchema, runSendToAgent } from './send_to_agent.js';
import { listAddressesSchema, runListAddresses } from './list_addresses.js';
import { getTeamStatusSchema, runGetTeamStatus } from './get_team_status.js';
import { searchSettingsSchema, runSearchSettings } from './search_settings.js';
import { callSettingSchema, runCallSetting } from './call_setting.js';
import { launchWorkflowSchema, runLaunchWorkflow } from './launch_workflow.js';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolDeps {
  env: PrimaryMcpEnv;
  comm?: import('../../mcp/comm-like.js').CommLike;
}

export type ToolHandler = (
  deps: ToolDeps,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

export const ALL_TOOLS: ToolEntry[] = [
  {
    schema: createLeaderSchema,
    handler: ({ env }, args) => runCreateLeader(env, args),
  },
  {
    schema: sendToAgentSchema,
    handler: ({ env, comm }, args) => runSendToAgent(env, comm!, args),
  },
  {
    schema: listAddressesSchema,
    handler: ({ env }, args) => runListAddresses(env, args),
  },
  {
    schema: getTeamStatusSchema,
    handler: ({ env }, args) => runGetTeamStatus(env, args),
  },
  {
    schema: searchSettingsSchema,
    handler: (_deps, args) => runSearchSettings(args),
  },
  {
    schema: callSettingSchema,
    handler: (_deps, args) => runCallSetting(args),
  },
  {
    schema: launchWorkflowSchema,
    handler: ({ env }, args) => runLaunchWorkflow(env, args),
  },
];

export function visibleTools(): ToolEntry[] {
  return ALL_TOOLS;
}

export function findTool(name: string): ToolEntry | undefined {
  return ALL_TOOLS.find((t) => t.schema.name === name);
}
