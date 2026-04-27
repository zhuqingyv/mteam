import type { PrimaryMcpEnv } from '../config.js';
import { createLeaderSchema, runCreateLeader } from './create_leader.js';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolDeps {
  env: PrimaryMcpEnv;
}

export type ToolHandler = (
  deps: ToolDeps,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

// 主 Agent 专属工具集。目前只实现 create_leader，
// send_to_agent / list_addresses / get_team_status 由并行成员实现后追加。
export const ALL_TOOLS: ToolEntry[] = [
  {
    schema: createLeaderSchema,
    handler: ({ env }, args) => runCreateLeader(env, args),
  },
];

export function visibleTools(): ToolEntry[] {
  return ALL_TOOLS;
}

export function findTool(name: string): ToolEntry | undefined {
  return ALL_TOOLS.find((t) => t.schema.name === name);
}
