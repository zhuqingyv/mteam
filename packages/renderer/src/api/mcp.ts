// MCP 工具与 Store 领域 —— [待 D6]
//
// 服务端现有端点 /api/mcp-store、/api/mcp-tools/search 都在顶级 /api/*，
// 前端硬门禁禁止直连。D6 facade 未落地前只能 stub。
//
// 未来服务端 facade 映射参考：
//   listMcpTools     → GET    /api/panel/mcp-tools?q=
//   listMcpServers   → GET    /api/panel/mcp-store
//   installMcpServer → POST   /api/panel/mcp-store/install
//   uninstallMcp     → DELETE /api/panel/mcp-store/:name

import { panelPending, type ApiResult } from './client';

export interface McpTool {
  name: string;
  serverName: string;
  description?: string;
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

export function listMcpTools(_q?: string): Promise<ApiResult<McpTool[]>> {
  return panelPending<McpTool[]>('mcp.listTools');
}

export function listMcpServers(): Promise<ApiResult<McpServer[]>> {
  return panelPending<McpServer[]>('mcp.listServers');
}

export function installMcpServer(_body: InstallMcpBody): Promise<ApiResult<McpServer>> {
  return panelPending<McpServer>('mcp.install');
}

export function uninstallMcpServer(_name: string): Promise<ApiResult<null>> {
  return panelPending<null>('mcp.uninstall');
}
