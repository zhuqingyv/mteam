// MCP 工具搜索 + 商店列表。install/uninstall facade 未暴露，保留占位。
// listMcpTools 的 query 必须自带 '?'，后端强校验 instanceId 和 q。

import { panelGet, panelPending, type ApiResult } from './client';

export interface McpTool {
  name: string;
  serverName: string;
  description?: string;
}

export interface McpSearchHit {
  mcpServer: string;
  toolName: string;
  description: string;
}

export interface McpServer {
  name: string;
  displayName?: string;
  description?: string;
  builtin: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
}

export interface InstallMcpBody {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
  displayName?: string;
  description?: string;
}

export function listMcpTools(
  query?: string,
): Promise<ApiResult<{ hits: McpSearchHit[] }>> {
  return panelGet<{ hits: McpSearchHit[] }>(`/mcp-tools${query ?? ''}`);
}

export function listMcpStore(): Promise<ApiResult<McpServer[]>> {
  return panelGet<McpServer[]>('/mcp/store');
}

export const listMcpServers = listMcpStore;

export function installMcpServer(_body: InstallMcpBody): Promise<ApiResult<McpServer>> {
  return panelPending<McpServer>('mcp.install');
}

export function uninstallMcpServer(_name: string): Promise<ApiResult<null>> {
  return panelPending<null>('mcp.uninstall');
}
