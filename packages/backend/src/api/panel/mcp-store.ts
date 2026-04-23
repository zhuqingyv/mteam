import type http from 'node:http';
import * as store from '../../mcp-store/store.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateString(v: unknown, field: string, max: number): string | null {
  if (typeof v !== 'string') return `${field} is required`;
  if (v.length < 1 || v.length > max) return `${field} must be 1~${max} chars`;
  return null;
}

export function handleListMcpStore(): ApiResponse {
  return { status: 200, body: store.listAll() };
}

export function handleInstallMcp(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');

  const nameErr = validateString(body.name, 'name', 64);
  if (nameErr) return errRes(400, nameErr);
  const cmdErr = validateString(body.command, 'command', 512);
  if (cmdErr) return errRes(400, cmdErr);

  if ('builtin' in body && body.builtin === true) {
    return errRes(400, 'builtin=true is not allowed');
  }
  if ('args' in body && body.args !== undefined && !Array.isArray(body.args)) {
    return errRes(400, 'args must be an array of strings');
  }
  if ('env' in body && body.env !== undefined && !isPlainObject(body.env)) {
    return errRes(400, 'env must be an object');
  }
  if ('transport' in body && body.transport !== undefined) {
    if (body.transport !== 'stdio' && body.transport !== 'sse') {
      return errRes(400, 'transport must be stdio or sse');
    }
  }

  const name = body.name as string;
  if (store.findByName(name)) {
    return errRes(409, `mcp '${name}' already exists`);
  }

  const config = store.install({
    name,
    displayName: (body.displayName as string | undefined) ?? name,
    description: (body.description as string | undefined) ?? '',
    command: body.command as string,
    args: (body.args as string[] | undefined) ?? [],
    env: (body.env as Record<string, string> | undefined) ?? {},
    transport: (body.transport as 'stdio' | 'sse' | undefined) ?? 'stdio',
  });
  return { status: 201, body: config };
}

export function handleUninstallMcp(name: string): ApiResponse {
  const existing = store.findByName(name);
  if (!existing) return errRes(404, `mcp '${name}' not found`);
  if (existing.builtin) return errRes(403, `mcp '${name}' is builtin and cannot be uninstalled`);
  try {
    store.uninstall(name);
    return { status: 204, body: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'uninstall failed';
    return errRes(500, msg);
  }
}

const PREFIX = '/api/mcp-store';
const INSTALL = '/api/mcp-store/install';

export async function routeMcpStore(
  req: http.IncomingMessage,
  pathname: string,
  readBody: () => Promise<unknown>,
): Promise<ApiResponse | null> {
  const method = req.method ?? 'GET';

  if (pathname === INSTALL) {
    if (method === 'POST') return handleInstallMcp(await readBody());
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname === PREFIX) {
    if (method === 'GET') return handleListMcpStore();
    return { status: 404, body: { error: 'not found' } };
  }

  if (pathname.startsWith(PREFIX + '/')) {
    const rest = pathname.slice(PREFIX.length + 1);
    if (!rest || rest.includes('/')) return { status: 404, body: { error: 'not found' } };
    let name: string;
    try {
      name = decodeURIComponent(rest);
    } catch {
      return { status: 400, body: { error: 'invalid name encoding' } };
    }
    if (method === 'DELETE') return handleUninstallMcp(name);
    return { status: 404, body: { error: 'not found' } };
  }

  return null;
}
