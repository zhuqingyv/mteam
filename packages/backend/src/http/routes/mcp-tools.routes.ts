// > 前端请走 /api/panel/mcp/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { routeMcpStore } from '../../api/panel/mcp-store.js';
import { handleSearchMcpTools } from '../../api/panel/mcp-tools.js';
import { readBody, notFound } from '../http-utils.js';

const MCP_TOOLS_SEARCH = '/api/mcp-tools/search';

export async function handleMcpToolsRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (pathname === MCP_TOOLS_SEARCH) {
    if (method === 'GET') return handleSearchMcpTools(query);
    return notFound;
  }

  // mcp-store 透传：匹配 /api/mcp-store[/…] 前缀，不匹配时返回 null。
  const mcpResp = await routeMcpStore(req, pathname, () => readBody(req));
  if (mcpResp) return mcpResp;

  return null;
}
