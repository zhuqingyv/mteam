// POST /mcp/searchTools 处理器：与 mteam-handler 形状一致，但不需要 CommLike。
// 从 X-Role-Instance-Id header 构造 SearchEnv；hubUrl 由 listener 注入。
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createSearchToolsServer, type SearchEnv } from '../searchtools/server.js';
import { readJsonBody, sendJsonError, sessions, type SessionMap } from './handler-utils.js';

export interface SearchToolsHandlerDeps {
  hubUrl: string;
  sessionMap?: SessionMap;
}

function envFromHeaders(req: IncomingMessage, hubUrl: string): SearchEnv | null {
  const v = req.headers['x-role-instance-id'];
  const instanceId = typeof v === 'string' ? v : '';
  if (!instanceId) return null;
  return { instanceId, hubUrl };
}

export function createSearchToolsHandler(deps: SearchToolsHandlerDeps) {
  const map = deps.sessionMap ?? sessions();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = typeof req.headers['mcp-session-id'] === 'string'
      ? req.headers['mcp-session-id']
      : undefined;

    if (sessionId && map.has(sessionId)) {
      const { transport } = map.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    const body = await readJsonBody(req);
    if (!body || !isInitializeRequest(body)) {
      sendJsonError(res, 400, 'Bad Request: No valid session ID provided');
      return;
    }

    const env = envFromHeaders(req, deps.hubUrl);
    if (!env) {
      sendJsonError(res, 400, 'Missing X-Role-Instance-Id header');
      return;
    }

    const server = createSearchToolsServer(env);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        map.set(sid, { transport, close: () => { void server.close(); } });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) map.delete(sid);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
