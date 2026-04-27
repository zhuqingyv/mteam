// member-agent driver-config —— 纯函数装配层。
// 调用方（Wave 2 的 member-driver/lifecycle 胶水）先从 domain 取出模板/实例，
// 先调 mcp manager 的 resolve() 把 MCP 产物算好，再把拿齐的数据塞进本函数。
// 本模块只做"已解析数据 → DriverConfig"的纯转换：
//   1) agentType <- cliType（窄校验：claude / codex / qwen 三选一）
//   2) systemPrompt <- assemblePrompt(...)（member-agent/prompt.ts）
//   3) mcpServers  <- launch-spec-builder(resolvedMcps.specs, runtimeKind)（§1.5）
//   4) env         <- ROLE_INSTANCE_ID / CLAUDE_MEMBER / IS_LEADER=0 / TEAM_HUB_NO_LAUNCH=1
// 不 import bus / domain / mcp-store/mcp-manager / primary-agent 等业务模块 ——
// 只 `import type`，业务胶水。launch-spec-builder 虽然放在 primary-agent/，但它
// 是纯函数（无副作用、无 bus），member-agent 复用合理——stage 4 TASK-LIST §W2-B。

import { homedir } from 'node:os';
import { assemblePrompt } from './prompt.js';
import { buildMcpServerSpecs } from '../primary-agent/launch-spec-builder.js';
import type {
  AgentType,
  DriverConfig,
  McpServerSpec,
} from '../agent-driver/types.js';
import type { ResolvedMcpSet } from '../mcp-store/types.js';

function cliTypeToAgentType(cliType: string): AgentType {
  if (cliType === 'claude' || cliType === 'codex' || cliType === 'qwen') {
    return cliType;
  }
  throw new Error(`unsupported cliType: ${cliType}`);
}

function mcpHttpBaseForHost(): string {
  return process.env.MCP_HTTP_BASE_HOST ?? 'http://localhost:58591';
}

function mcpHttpBaseForDocker(): string {
  return process.env.MCP_HTTP_BASE_DOCKER ?? 'http://host.docker.internal:58591';
}

export interface BuildMemberDriverConfigInput {
  instance: {
    id: string;
    memberName: string;
    leaderName: string | null;
    task?: string | null;
    runtimeKind?: 'host' | 'docker';
  };
  template: {
    persona?: string | null;
    role?: { cliType?: string };
  };
  resolvedMcps: ResolvedMcpSet;
  cwd?: string;
}

export function buildMemberDriverConfig(input: BuildMemberDriverConfigInput): {
  config: DriverConfig;
  skipped: string[];
} {
  const { instance, template, resolvedMcps } = input;

  const cliType = template.role?.cliType ?? 'claude';
  const systemPrompt = assemblePrompt({
    memberName: instance.memberName,
    isLeader: false,
    leaderName: instance.leaderName ?? null,
    persona: template.persona ?? null,
    task: instance.task ?? null,
  });

  const mcpServers: McpServerSpec[] = buildMcpServerSpecs({
    resolved: resolvedMcps,
    runtimeKind: instance.runtimeKind ?? 'host',
    instanceId: instance.id,
    mcpHttpBaseForHost: mcpHttpBaseForHost(),
    mcpHttpBaseForDocker: mcpHttpBaseForDocker(),
  });

  const config: DriverConfig = {
    agentType: cliTypeToAgentType(cliType),
    systemPrompt,
    mcpServers,
    cwd: input.cwd ?? homedir(),
    env: {
      ROLE_INSTANCE_ID: instance.id,
      CLAUDE_MEMBER: instance.memberName,
      IS_LEADER: '0',
      TEAM_HUB_NO_LAUNCH: '1',
    },
  };

  return { config, skipped: resolvedMcps.skipped };
}
