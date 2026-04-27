// 把 mcpManager.resolve() 产物（ResolvedMcpSpec[]）按 runtimeKind 分流成 AgentDriver
// 吃的 McpServerSpec[]。Stage 4 W2-B §1.5。
//
// 分流规则：
//   builtin + host   → transport=http, url=<mcpHttpBaseForHost>/mcp/<name>
//   builtin + docker → transport=http, url=<mcpHttpBaseForDocker>/mcp/<name>
//   user-stdio (两种 runtime) → transport=stdio 原样透传（Stage 5 再处理 docker volume）
//
// builtin HTTP 分支必须带 header：
//   X-Role-Instance-Id : instanceId（必填，listener 反构 MteamEnv 取这个）
//   X-Is-Leader        : '1'|'0'（仅 mteam）
//   X-Tool-Visibility  : JSON.stringify(visibility)（仅 mteam，空 {} 表示 *）
//
// `runtimeKind` 只是 builder 的输入，调用方（primary/member driver-config）在构造
// LaunchSpec 时需自行把 runtimeKind 映射到 LaunchSpec.runtime（INTERFACE-CONTRACTS §3）。

import type { McpServerSpec } from '../agent-driver/types.js';
import type { ResolvedMcpSet, ResolvedMcpSpec } from '../mcp-store/types.js';

export interface LaunchSpecBuilderInput {
  resolved: ResolvedMcpSet;
  runtimeKind: 'host' | 'docker';
  instanceId: string;
  mcpHttpBaseForHost: string;
  mcpHttpBaseForDocker: string;
}

export function buildMcpServerSpecs(
  input: LaunchSpecBuilderInput,
): McpServerSpec[] {
  const { resolved, runtimeKind, instanceId } = input;
  const base =
    runtimeKind === 'docker'
      ? input.mcpHttpBaseForDocker
      : input.mcpHttpBaseForHost;

  return resolved.specs.map((spec) => toServerSpec(spec, base, instanceId));
}

function toServerSpec(
  spec: ResolvedMcpSpec,
  mcpHttpBase: string,
  instanceId: string,
): McpServerSpec {
  if (spec.kind === 'builtin') {
    return {
      name: spec.name,
      transport: 'http',
      url: `${mcpHttpBase}/mcp/${spec.name}`,
      headers: buildBuiltinHeaders(spec, instanceId),
    };
  }
  return {
    name: spec.name,
    transport: 'stdio',
    command: spec.command,
    args: spec.args,
    env: spec.env,
  };
}

function buildBuiltinHeaders(
  spec: Extract<ResolvedMcpSpec, { kind: 'builtin' }>,
  instanceId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Role-Instance-Id': instanceId,
  };
  if (spec.name === 'mteam') {
    headers['X-Is-Leader'] = spec.env.IS_LEADER === '1' ? '1' : '0';
    headers['X-Tool-Visibility'] = JSON.stringify(spec.visibility);
  }
  return headers;
}
