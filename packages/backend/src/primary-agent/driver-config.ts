// PrimaryAgentRow → AgentDriver DriverConfig 的装配层。
// 通过 mcpManager.resolve() 拿 ResolvedMcpSet，再交给 launch-spec-builder
// 按 runtimeKind 分流（host/docker 下 builtin 走 HTTP、user-stdio 走 stdio）。
// cliType 到 AgentType 的映射在这里收敛，避免把字符串直接扔给 driver。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpManager } from '../mcp-store/mcp-manager.js';
import { cliManager } from '../cli-scanner/manager.js';
import type {
  AgentType,
  DriverConfig,
  McpServerSpec,
} from '../agent-driver/types.js';
import type { PrimaryAgentRow } from './types.js';
import { buildMcpServerSpecs } from './launch-spec-builder.js';

export function defaultCommSock(): string {
  return (
    process.env.TEAM_HUB_COMM_SOCK ??
    join(homedir(), '.claude', 'team-hub', 'comm.sock')
  );
}

function defaultHubUrl(): string {
  return `http://localhost:${process.env.V2_PORT ?? '58590'}`;
}

function mcpHttpBaseForHost(): string {
  return process.env.MCP_HTTP_BASE_HOST ?? 'http://localhost:58591';
}

function mcpHttpBaseForDocker(): string {
  return process.env.MCP_HTTP_BASE_DOCKER ?? 'http://host.docker.internal:58591';
}

// 主 Agent row 目前没有 runtime_kind 字段，上层按 env 兜底；与 sandbox-deps.ts 的
// readRuntimeConfig 保持同一个 env 变量，避免两套开关走偏。调用方（primary-agent.ts）
// 应该在装配前把 env → runtimeKind 的映射算好再传进来，这里只做纯转换。
export function resolveRuntimeKindFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): 'host' | 'docker' {
  return env.TEAM_HUB_RUNTIME_KIND === 'docker' ? 'docker' : 'host';
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
  runtimeKind?: 'host' | 'docker';
  // 仅主 Agent 路径使用：追加到 systemPrompt 末尾的历史对话 XML 块。
  historyPromptBlock?: string;
}

export function buildDriverConfig(input: BuildDriverConfigInput): {
  config: DriverConfig;
  skipped: string[];
} {
  const { row } = input;
  const runtimeKind = input.runtimeKind ?? 'host';
  const resolved = mcpManager.resolveForPrimary(row.mcpConfig, {
    instanceId: row.id,
    hubUrl: defaultHubUrl(),
  });

  const mcpServers: McpServerSpec[] = buildMcpServerSpecs({
    resolved,
    runtimeKind,
    instanceId: row.id,
    mcpHttpBaseForHost: mcpHttpBaseForHost(),
    mcpHttpBaseForDocker: mcpHttpBaseForDocker(),
  });

  const basePrompt = row.systemPrompt ?? '';
  const block = input.historyPromptBlock ?? '';
  const systemPrompt = block ? basePrompt + block : basePrompt;

  const config: DriverConfig = {
    agentType: cliTypeToAgentType(row.cliType),
    systemPrompt,
    mcpServers,
    cwd: input.cwd ?? homedir(),
    autoApprove: row.autoApprove,
    env: {
      ...process.env as Record<string, string>,
      ROLE_INSTANCE_ID: row.id,
      CLAUDE_MEMBER: row.name,
      IS_LEADER: '1',
      TEAM_HUB_NO_LAUNCH: '1',
      ...(cliManager.getInfo(row.cliType)?.path
        ? { CLAUDE_CODE_EXECUTABLE: cliManager.getInfo(row.cliType)!.path! }
        : {}),
    },
  };

  return { config, skipped: resolved.skipped };
}
