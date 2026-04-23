import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getDb, closeDb } from './db/connection.js';
import { RoleInstance } from './domain/role-instance.js';
import { CommServer } from './comm/index.js';
import {
  handleCreateTemplate,
  handleListTemplates,
  handleGetTemplate,
  handleUpdateTemplate,
  handleDeleteTemplate,
} from './api/panel/role-templates.js';
import {
  handleCreateInstance,
  handleListInstances,
  handleDeleteInstance,
  handleActivate,
  handleRequestOffline,
} from './api/panel/role-instances.js';
import { handleRegisterSession } from './api/panel/sessions.js';
import {
  handleListRoster,
  handleSearchRoster,
  handleGetRosterEntry,
  handleAddRoster,
  handleUpdateRoster,
  handleSetAlias,
  handleDeleteRoster,
} from './api/panel/roster.js';
import { routeMcpStore } from './api/panel/mcp-store.js';
import { ensureDefaults as ensureMcpDefaults } from './mcp-store/store.js';
import type { ApiResponse } from './api/panel/role-templates.js';

const DEFAULT_PORT = 58580;
const PREFIX = '/api/role-templates';
const INSTANCES_PREFIX = '/api/role-instances';
const SESSIONS_REGISTER = '/api/sessions/register';
const ROSTER_PREFIX = '/api/roster';
const ROSTER_SEARCH = '/api/roster/search';
const PANEL_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'panel.html');

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// CORS 公共头：允许本地开发面板（Vite 5174 等）跨域调用 58580。
// 前端浏览器跨域会先发预检（OPTIONS），若缺失这些头会直接失败。
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type,X-Role-Instance-Id,X-Requested-With,Authorization',
  'Access-Control-Max-Age': '600',
};

function jsonResponse(res: http.ServerResponse, resp: ApiResponse): void {
  if (resp.status === 204) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const body = JSON.stringify(resp.body);
  res.writeHead(resp.status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function route(req: http.IncomingMessage): Promise<ApiResponse> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const queryStr = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
  const query = new URLSearchParams(queryStr);

  if (pathname === ROSTER_SEARCH) {
    if (method === 'GET') return handleSearchRoster(query);
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname === ROSTER_PREFIX) {
    if (method === 'GET') return handleListRoster(query);
    if (method === 'POST') {
      const body = await readBody(req);
      return handleAddRoster(body);
    }
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname.startsWith(ROSTER_PREFIX + '/')) {
    const rest = pathname.slice(ROSTER_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 1 && parts[0]) {
      const instanceId = parts[0];
      if (method === 'GET') return handleGetRosterEntry(instanceId);
      if (method === 'PUT') {
        const body = await readBody(req);
        return handleUpdateRoster(instanceId, body);
      }
      if (method === 'DELETE') return handleDeleteRoster(instanceId);
      return { status: 404, body: { error: 'not found' } };
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'alias') {
      if (method === 'PUT') {
        const body = await readBody(req);
        return handleSetAlias(parts[0], body);
      }
    }
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname === PREFIX) {
    if (method === 'GET') return handleListTemplates();
    if (method === 'POST') {
      const body = await readBody(req);
      return handleCreateTemplate(body);
    }
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname === SESSIONS_REGISTER) {
    if (method === 'POST') {
      const body = await readBody(req);
      return handleRegisterSession(body);
    }
    return { status: 404, body: { error: 'not found' } };
  }

  const mcpResp = await routeMcpStore(req, pathname, () => readBody(req));
  if (mcpResp) return mcpResp;

  if (pathname === INSTANCES_PREFIX) {
    if (method === 'GET') return handleListInstances();
    if (method === 'POST') {
      const body = await readBody(req);
      return handleCreateInstance(body);
    }
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname.startsWith(INSTANCES_PREFIX + '/')) {
    const rest = pathname.slice(INSTANCES_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 1 && parts[0]) {
      if (method === 'DELETE') return handleDeleteInstance(parts[0], query.get('force') === '1');
      return { status: 404, body: { error: 'not found' } };
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'activate' && method === 'POST') {
      return handleActivate(parts[0]);
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'request-offline' && method === 'POST') {
      const body = await readBody(req);
      // 从 header X-Role-Instance-Id 读调用者 ID，body 字段作 fallback。
      const hdr = req.headers['x-role-instance-id'];
      const headerCaller = typeof hdr === 'string' && hdr.length > 0 ? hdr : null;
      return handleRequestOffline(parts[0], body, headerCaller);
    }
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname.startsWith(PREFIX + '/')) {
    const rawName = pathname.slice(PREFIX.length + 1);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return { status: 400, body: { error: 'invalid name encoding' } };
    }
    if (!name || name.includes('/')) {
      return { status: 404, body: { error: 'not found' } };
    }
    if (method === 'GET') return handleGetTemplate(name);
    if (method === 'PUT') {
      const body = await readBody(req);
      return handleUpdateTemplate(name, body);
    }
    if (method === 'DELETE') return handleDeleteTemplate(name);
    return { status: 404, body: { error: 'not found' } };
  }

  return { status: 404, body: { error: 'not found' } };
}

function servePanelHtml(res: http.ServerResponse): void {
  try {
    const html = readFileSync(PANEL_HTML_PATH);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.byteLength,
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('panel.html not found');
  }
}

export function createServer(): http.Server {
  getDb();
  ensureMcpDefaults();
  return http.createServer(async (req, res) => {
    try {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      // CORS 预检：浏览器对非简单请求会先发 OPTIONS，直接回 204 + 跨域头放行。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/panel')) {
        servePanelHtml(res);
        return;
      }
      const resp = await route(req);
      jsonResponse(res, resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'internal server error';
      process.stderr.write(`[v2] error: ${msg}\n`);
      jsonResponse(res, { status: 500, body: { error: 'internal server error' } });
    }
  });
}

function reconcileStaleInstances(): void {
  const stale = RoleInstance.listAll();
  for (const inst of stale) {
    if (inst.sessionPid) {
      try {
        process.kill(inst.sessionPid, 0);
      } catch {
        process.stderr.write(
          `[v2] reconcile: removing zombie instance ${inst.id} (pid=${inst.sessionPid} gone)\n`,
        );
        inst.delete();
      }
    } else {
      process.stderr.write(
        `[v2] reconcile: removing zombie instance ${inst.id} (no session_pid)\n`,
      );
      inst.delete();
    }
  }
}

export function startServer(port?: number): http.Server {
  const server = createServer();
  reconcileStaleInstances();
  const p = port ?? (Number(process.env.V2_PORT) || DEFAULT_PORT);
  server.listen(p, () => {
    process.stderr.write(`[v2] listening on port ${p}\n`);
  });

  const comm = new CommServer();
  const sockPath =
    process.env.TEAM_HUB_COMM_SOCK ||
    join(homedir(), '.claude', 'team-hub', 'comm.sock');
  comm
    .start(sockPath)
    .then(() => process.stderr.write(`[v2] comm listening at ${sockPath}\n`))
    .catch((e) =>
      process.stderr.write(`[v2] comm failed to start: ${(e as Error).message}\n`),
    );

  const shutdown = (): void => {
    comm.stop().finally(() => {
      server.close(() => {
        closeDb();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  startServer();
}
