// POST /mcp/mteam 处理器：从请求头构造 MteamEnv + InProcessComm，
// 每个新 session new 一个 Server 实例挂 StreamableHTTPServerTransport。
// 已有 session 复用已缓存的 transport。
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMteamServer } from '../mcp/server.js';
import type { MteamEnv } from '../mcp/config.js';
import { InProcessComm } from './in-process-comm.js';
import type { CommRouter } from '../comm/router.js';
import { readJsonBody, sendJsonError, sessions, type SessionMap } from './handler-utils.js';

export interface MteamHandlerDeps {
  router: CommRouter;
  hubUrl: string;
  sessionMap?: SessionMap;
}

function envFromHeaders(req: IncomingMessage, hubUrl: string): MteamEnv | null {
  const h = req.headers;
  const instanceId = typeof h['x-role-instance-id'] === 'string' ? h['x-role-instance-id'] : '';
  if (!instanceId) return null;
  const isLeader = h['x-is-leader'] === '1';
  return { instanceId, hubUrl, commSock: '', isLeader };
}

export function createMteamHandler(deps: MteamHandlerDeps) {
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

    const comm = new InProcessComm({ router: deps.router, selfAddress: `local:${env.instanceId}` });
    const server = createMteamServer(env, comm);
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
