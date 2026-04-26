// MCP 工具搜索 + 商店。全部走 /api/panel/* facade。
// 注意：install / uninstall 的 panel 门面尚未开放（INDEX §5.1），用 panelPending 占位。

import { panelGet, panelPending, type ApiResult } from './client';

export interface McpSearchHit {
  mcpServer: string;
  toolName: string;
  description: string;
}

export interface McpConfig {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: 'stdio' | 'sse';
  builtin: boolean;
}

/** @deprecated use McpConfig */
export type McpServer = McpConfig;

export function listMcpTools(
  instanceId: string,
  q: string,
): Promise<ApiResult<{ hits: McpSearchHit[] }>> {
  const params = new URLSearchParams({ instanceId, q });
  return panelGet<{ hits: McpSearchHit[] }>(`/mcp-tools?${params.toString()}`);
}

export function listMcpStore(): Promise<ApiResult<McpConfig[]>> {
  return panelGet<McpConfig[]>('/mcp/store');
}

export const listMcpServers = listMcpStore;

export function installMcpServer(_body: unknown): Promise<ApiResult<McpConfig>> {
  return panelPending<McpConfig>('mcp-store.install');
}

export function uninstallMcpServer(_name: string): Promise<ApiResult<null>> {
  return panelPending<null>('mcp-store.uninstall');
}
