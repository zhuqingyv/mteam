import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PrimaryMcpEnv } from './config.js';
import { findTool, visibleTools, type ToolDeps } from './tools/registry.js';

function toTextResult(
  data: unknown,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const isError =
    data !== null &&
    typeof data === 'object' &&
    'error' in (data as Record<string, unknown>);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

// 构造 mteam-primary MCP Server：注册 ListTools / CallTool，不 connect、不绑 signal。
// 由调用方负责挂 transport 与清理。主 Agent 专属，无 leader/member 区分。
export function createMteamPrimaryServer(env: PrimaryMcpEnv): Server {
  const deps: ToolDeps = { env };

  const server = new Server(
    { name: 'mteam-primary', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools().map((t) => t.schema),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const entry = findTool(name);
    if (!entry) return toTextResult({ error: `unknown tool: ${name}` });
    try {
      return toTextResult(await entry.handler(deps, args));
    } catch (e) {
      return toTextResult({ error: (e as Error).message });
    }
  });

  return server;
}
