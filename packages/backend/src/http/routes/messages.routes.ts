// > 前端请走 POST /api/panel/messages 门面层，不要直接调用本接口。
// W2-I · /api/messages + /api/role-instances/:id/inbox + /api/teams/:teamId/messages
// 对齐 comm-model-frontend.md §7；不做鉴权（Phase 2 再加）。
// POST /send 强注入 from.kind='user'；允许 body.from.displayName 覆盖默认 'User'（W2-C）。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { buildEnvelope } from '../../comm/envelope-builder.js';
import { lookupAgentByInstanceId } from '../../comm/agent-lookup.js';
import { parseAddress } from '../../comm/protocol.js';
import { getDb } from '../../db/connection.js';
import { readBody, notFound } from '../http-utils.js';
import { getMessagesContext } from '../messages-context.js';

const err = (status: number, error: string): ApiResponse => ({ status, body: { error } });

const ALLOWED_TO_KINDS = new Set(['agent']);
const ALLOWED_KINDS = new Set(['chat', 'task', 'broadcast']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lookupAgentByAddress(address: string) {
  let id: string;
  try { id = parseAddress(address).id; } catch { return null; }
  return lookupAgentByInstanceId(id);
}

function readQueryInt(q: URLSearchParams, key: string, max: number): number | undefined {
  const raw = q.get(key);
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n;
}

export async function handleSend(req: http.IncomingMessage): Promise<ApiResponse> {
  const ct = (req.headers['content-type'] ?? '').toString();
  if (!ct.toLowerCase().includes('application/json')) {
    return err(415, 'Content-Type must be application/json');
  }
  let body: unknown;
  try { body = await readBody(req); } catch { return err(400, 'invalid JSON body'); }
  if (!isObj(body)) return err(400, 'body must be a JSON object');

  let fromDisplayNameOverride: string | undefined;
  if ('from' in body && body.from !== undefined) {
    const fromRaw = body.from;
    if (!isObj(fromRaw)) return err(400, 'from must be an object if provided');
    if (fromRaw.kind !== undefined && fromRaw.kind !== 'user') {
      return err(400, `from.kind='${String(fromRaw.kind)}' not allowed; HTTP send is user-only in this phase`);
    }
    if (fromRaw.displayName !== undefined) {
      if (typeof fromRaw.displayName !== 'string') return err(400, 'from.displayName must be a string');
      const trimmed = fromRaw.displayName.trim();
      if (trimmed.length === 0) return err(400, 'from.displayName must be non-empty after trim');
      if (trimmed.length > 64) return err(400, 'from.displayName exceeds 64 chars');
      fromDisplayNameOverride = trimmed;
    }
  }

  const to = body.to;
  if (!isObj(to) || typeof to.address !== 'string' || to.address.length === 0) {
    return err(400, 'to.address is required');
  }
  const toKind = typeof to.kind === 'string' ? to.kind : 'agent';
  if (!ALLOWED_TO_KINDS.has(toKind)) return err(400, `to.kind must be one of ${[...ALLOWED_TO_KINDS].join(',')}`);

  const content = typeof body.content === 'string' ? body.content : '';
  if (content.length === 0) return err(400, 'content is required');

  const kindRaw = typeof body.kind === 'string' ? body.kind : 'chat';
  if (!ALLOWED_KINDS.has(kindRaw)) return err(400, `kind must be one of ${[...ALLOWED_KINDS].join(',')}`);

  const lookup = lookupAgentByAddress(to.address);
  if (!lookup) return err(404, `to not found: ${to.address}`);
  if (typeof to.instanceId === 'string' && to.instanceId !== lookup.instanceId) {
    return err(400, 'to.instanceId does not match parsed address');
  }

  const { router } = getMessagesContext();
  if (!router) return err(503, 'comm router not initialized');

  const env = buildEnvelope({
    fromKind: 'user',
    fromAddress: 'user:local',
    fromDisplayNameOverride,
    toAddress: to.address,
    toLookup: lookup,
    summary: typeof body.summary === 'string' ? body.summary : null,
    content,
    kind: kindRaw as 'chat' | 'task' | 'broadcast',
    replyTo: typeof body.replyTo === 'string' ? body.replyTo : null,
    attachments: Array.isArray(body.attachments) ? (body.attachments as Array<{ type: string }>) : undefined,
  });

  const outcome = await router.dispatch(env);
  if (outcome.route === 'dropped') return err(400, `dropped: ${outcome.reason}`);
  if (outcome.route === 'remote-unsupported') return err(400, `remote scope '${outcome.scope}' unsupported`);
  return { status: 200, body: { messageId: env.id, route: outcome.route } };
}

function handleGetById(id: string, query: URLSearchParams): ApiResponse {
  const { store } = getMessagesContext();
  const env = store.findById(id);
  if (!env) return err(404, `message '${id}' not found`);
  if (query.get('markRead') === 'true') {
    store.markRead(id);
    const refreshed = store.findById(id);
    if (refreshed) return { status: 200, body: { envelope: refreshed } };
  }
  return { status: 200, body: { envelope: env } };
}

/**
 * GET /api/role-instances/:id/inbox
 * 默认 peek=true（不标已读）—— HTTP 面板语义：GET 应幂等，打开面板不应清未读。
 * 如需对齐 MCP check_inbox 语义（看完即读完），请显式传 peek=false。
 * 两端默认值有意不同，见 docs/phase-comm-fix/TASK-LIST.md §D2。
 */
function handleInbox(instanceId: string, query: URLSearchParams): ApiResponse {
  const exists = getDb()
    .prepare(`SELECT 1 FROM role_instances WHERE id = ?`)
    .get(instanceId) as { 1: 1 } | undefined;
  if (!exists) return err(404, `role instance '${instanceId}' not found`);
  // peek=true（默认）不标已读；peek=false 把返回的全部标已读。
  const peekRaw = query.get('peek');
  const peek = peekRaw === null ? true : peekRaw !== 'false';
  const limit = readQueryInt(query, 'limit', 200) ?? 50;
  const { store } = getMessagesContext();
  return { status: 200, body: store.listInbox(instanceId, { peek, limit }) };
}

function handleTeamHistory(teamId: string, query: URLSearchParams): ApiResponse {
  const limit = readQueryInt(query, 'limit', 200) ?? 50;
  const before = query.get('before') ?? undefined;
  const { store } = getMessagesContext();
  return { status: 200, body: store.listTeamHistory(teamId, { before, limit }) };
}

export async function handleMessagesRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (pathname === '/api/messages/send') {
    if (method === 'POST') return handleSend(req);
    return notFound;
  }

  if (pathname.startsWith('/api/messages/')) {
    const id = pathname.slice('/api/messages/'.length);
    if (!id || id.includes('/')) return notFound;
    if (method === 'GET') return handleGetById(id, query);
    return notFound;
  }

  if (pathname.startsWith('/api/role-instances/') && pathname.endsWith('/inbox')) {
    const rest = pathname.slice('/api/role-instances/'.length, -'/inbox'.length);
    if (!rest || rest.includes('/')) return null; // 让 instances.routes 处理其它子路径
    if (method === 'GET') return handleInbox(rest, query);
    return notFound;
  }

  if (pathname.startsWith('/api/teams/') && pathname.endsWith('/messages')) {
    const rest = pathname.slice('/api/teams/'.length, -'/messages'.length);
    if (!rest || rest.includes('/')) return null;
    if (method === 'GET') return handleTeamHistory(rest, query);
    return notFound;
  }

  return null;
}
