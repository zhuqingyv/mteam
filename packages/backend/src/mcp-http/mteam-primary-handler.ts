// POST /mcp/mteam-primary 处理器：主 Agent 专属 MCP 的 HTTP 入口。
// 结构照抄 mteam-handler.ts：per-session 新建 Server + StreamableHTTPServerTransport，
// sessionId 映射复用已缓存 transport。env 从 X-Role-Instance-Id header 读。
//
// 注：当前 createMteamPrimaryServer 只收 env；一旦 registry 把 ToolDeps 扩成含 comm，
// 这里会一并传 InProcessComm（send_to_agent 需要）。
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMteamPrimaryServer } from '../mcp-primary/server.js';
import type { PrimaryMcpEnv } from '../mcp-primary/config.js';
import { InProcessComm } from './in-process-comm.js';
import type { CommRouter } from '../comm/router.js';
import { readJsonBody, sendJsonError, sessions, type SessionMap } from './handler-utils.js';

export interface MteamPrimaryHandlerDeps {
  router: CommRouter;
  hubUrl: string;
  sessionMap?: SessionMap;
}

function envFromHeaders(req: IncomingMessage, hubUrl: string): PrimaryMcpEnv | null {
  const h = req.headers;
  const instanceId = typeof h['x-role-instance-id'] === 'string' ? h['x-role-instance-id'] : '';
  if (!instanceId) return null;
  return { instanceId, hubUrl };
}

export function createMteamPrimaryHandler(deps: MteamPrimaryHandlerDeps) {
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

    // InProcessComm 预建：send_to_agent 需要。构造成本极低，registry 扩展 comm 时直接接入。
    const comm = new InProcessComm({ router: deps.router, selfAddress: `local:${env.instanceId}` });
    const server = createMteamPrimaryServer(env);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        map.set(sid, { transport, close: () => { comm.close(); void server.close(); } });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) map.delete(sid);
      comm.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
