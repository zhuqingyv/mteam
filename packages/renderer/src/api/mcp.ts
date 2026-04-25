// MCP 工具搜索 + 商店。全部走 /api/panel/* facade。

import { panelGet, panelPost, panelDelete, type ApiResult } from './client';

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
  instanceId?: string,
  q?: string,
): Promise<ApiResult<{ hits: McpSearchHit[] }>> {
  const params = new URLSearchParams();
  if (instanceId) params.set('instanceId', instanceId);
  if (q) params.set('q', q);
  const qs = params.toString();
  return panelGet<{ hits: McpSearchHit[] }>(`/mcp/tools${qs ? `?${qs}` : ''}`);
}

export function listMcpStore(): Promise<ApiResult<McpServer[]>> {
  return panelGet<McpServer[]>('/mcp/store');
}

export const listMcpServers = listMcpStore;

export function installMcpServer(body: InstallMcpBody): Promise<ApiResult<McpServer>> {
  return panelPost<McpServer>('/mcp-store/install', body);
}

export function uninstallMcpServer(name: string): Promise<ApiResult<null>> {
  return panelDelete<null>(`/mcp-store/${encodeURIComponent(name)}`);
}
