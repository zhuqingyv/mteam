// searchTools MCP server —— 只注册一个 `search` 工具，HTTP 回调 backend
// 查当前角色模板的次屏工具清单（模板配了但不在 surface 的工具）。
// 不做动态注册、不发 list_changed，agent 拿到 name 就直接调目标 MCP 的工具。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface SearchEnv {
  instanceId: string;
  hubUrl: string;
}

function readEnv(): SearchEnv {
  const instanceId = process.env.ROLE_INSTANCE_ID ?? '';
  if (!instanceId) throw new Error('ROLE_INSTANCE_ID env is required');
  const port = process.env.V2_PORT ?? '58580';
  const hubUrl =
    process.env.V2_SERVER_URL ??
    process.env.TEAM_HUB_URL ??
    `http://localhost:${port}`;
  return { instanceId, hubUrl };
}

export const searchSchema = {
  name: 'search',
  description:
    'Search for additional tools available to you but not shown in the default list. Returns tool names and descriptions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keyword to search tool names and descriptions',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

interface SearchHit {
  mcpServer: string;
  toolName: string;
  description: string;
}

async function runSearch(
  env: SearchEnv,
  args: { query?: unknown },
): Promise<{ hits: SearchHit[] } | { error: string }> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return { error: 'query is required' };
  const url =
    `${env.hubUrl}/api/mcp-tools/search` +
    `?instanceId=${encodeURIComponent(env.instanceId)}` +
    `&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text();
      return { error: `search failed (HTTP ${res.status}): ${text}` };
    }
    const body = (await res.json()) as { hits?: SearchHit[] };
    return { hits: body.hits ?? [] };
  } catch (e) {
    return { error: `network error: ${(e as Error).message}` };
  }
}

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

// 纯构造：给 env，返回挂好 list/call handler 的 Server。
// transport / signal / 日志由调用方负责（mcp-http listener、单测、stdio 入口）。
export function createSearchToolsServer(env: SearchEnv): Server {
  const server = new Server(
    { name: 'searchTools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [searchSchema],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'search') return toTextResult(await runSearch(env, args));
      return toTextResult({ error: `unknown tool: ${name}` });
    } catch (e) {
      return toTextResult({ error: (e as Error).message });
    }
  });

  return server;
}

export async function runSearchToolsServer(): Promise<void> {
  const env = readEnv();
  const server = createSearchToolsServer(env);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[searchtools] ready instance=${env.instanceId} hub=${env.hubUrl}\n`,
  );
}
