// MCP HTTP listener：挂两条内置 MCP —— /mcp/mteam & /mcp/searchTools。
// 默认端口 58591（env MCP_HTTP_PORT），host 固定 '127.0.0.1' —— agent 容器通过
// host.docker.internal 映射访问。设计见 docs/phase-sandbox-acp/stage-4-mcp-http.md。
import http from 'node:http';
import { createMteamHandler } from './mteam-handler.js';
import { createMteamPrimaryHandler } from './mteam-primary-handler.js';
import { createSearchToolsHandler } from './searchtools-handler.js';
import { closeAll, sessions, sendJsonError } from './handler-utils.js';
import type { CommRouter } from '../comm/router.js';

export interface McpHttpOptions {
  port?: number;
  host?: string;
  hubUrl: string;
  commRouter: CommRouter;
}

export interface McpHttpHandle {
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 58591;
const DEFAULT_HOST = '127.0.0.1';

function resolvePort(opt?: number): number {
  if (typeof opt === 'number') return opt;
  const env = process.env.MCP_HTTP_PORT;
  if (env && /^\d+$/.test(env)) return Number(env);
  return DEFAULT_PORT;
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const port = resolvePort(opts.port);
  const host = opts.host ?? DEFAULT_HOST;
  const mteamMap = sessions();
  const searchMap = sessions();
  const primaryMap = sessions();
  const mteamHandler = createMteamHandler({
    router: opts.commRouter,
    hubUrl: opts.hubUrl,
    sessionMap: mteamMap,
  });
  const primaryHandler = createMteamPrimaryHandler({
    router: opts.commRouter,
    hubUrl: opts.hubUrl,
    sessionMap: primaryMap,
  });
  const searchHandler = createSearchToolsHandler({
    hubUrl: opts.hubUrl,
    sessionMap: searchMap,
  });

  const server = http.createServer((req, res) => {
    void dispatch(req, res, mteamHandler, primaryHandler, searchHandler).catch((e: Error) => {
      if (!res.headersSent) sendJsonError(res, 500, `internal: ${e.message}`);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  return {
    url,
    close: async () => {
      closeAll(mteamMap);
      closeAll(primaryMap);
      closeAll(searchMap);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mteam: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
  primary: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
  search: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?', 1)[0];
  if (path === '/mcp/mteam') return mteam(req, res);
  if (path === '/mcp/mteam-primary') return primary(req, res);
  if (path === '/mcp/searchTools') return search(req, res);
  sendJsonError(res, 404, `no handler for ${path}`);
}
