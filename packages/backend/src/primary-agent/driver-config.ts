// PrimaryAgentRow → AgentDriver DriverConfig 的装配层。
// 把 McpToolVisibility[] 通过 mcpManager.resolve() 展开，
// 再把产物转成 AgentDriver 认的 McpServerSpec[]。
// cliType 到 AgentType 的映射在这里收敛，避免把字符串直接扔给 driver。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpManager } from '../mcp-store/mcp-manager.js';
import type {
  AgentType,
  DriverConfig,
  McpServerSpec,
} from '../agent-driver/types.js';
import type { PrimaryAgentRow } from './types.js';

export function defaultCommSock(): string {
  return (
    process.env.TEAM_HUB_COMM_SOCK ??
    join(homedir(), '.claude', 'team-hub', 'comm.sock')
  );
}

function defaultHubUrl(): string {
  return `http://localhost:${process.env.V2_PORT ?? '58590'}`;
}

export function cliTypeToAgentType(cliType: string): AgentType {
  if (cliType === 'claude' || cliType === 'codex' || cliType === 'qwen') {
    return cliType;
  }
  throw new Error(`unsupported cliType: ${cliType}`);
}

export interface BuildDriverConfigInput {
  row: PrimaryAgentRow;
  cwd?: string;
}

export function buildDriverConfig(input: BuildDriverConfigInput): {
  config: DriverConfig;
  skipped: string[];
} {
  const { row } = input;
  const resolved = mcpManager.resolve(row.mcpConfig, {
    instanceId: row.id,
    hubUrl: defaultHubUrl(),
    commSock: defaultCommSock(),
    isLeader: true,
  });

  const mcpServers: McpServerSpec[] = Object.entries(
    resolved.configJson.mcpServers,
  ).map(([name, spec]) => ({
    name,
    transport: 'stdio',
    command: spec.command,
    args: spec.args,
    env: spec.env,
  }));

  const config: DriverConfig = {
    agentType: cliTypeToAgentType(row.cliType),
    systemPrompt: row.systemPrompt,
    mcpServers,
    cwd: input.cwd ?? homedir(),
    env: {
      ROLE_INSTANCE_ID: row.id,
      CLAUDE_MEMBER: row.name,
      IS_LEADER: '1',
      TEAM_HUB_NO_LAUNCH: '1',
    },
  };

  return { config, skipped: resolved.skipped };
}
