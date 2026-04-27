// > 前端请走 /api/panel/roster/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  handleListRoster,
  handleSearchRoster,
  handleGetRosterEntry,
  handleAddRoster,
  handleUpdateRoster,
  handleSetAlias,
  handleDeleteRoster,
} from '../../api/panel/roster.js';
import { readBody, notFound } from '../http-utils.js';

const ROSTER_PREFIX = '/api/roster';
const ROSTER_SEARCH = '/api/roster/search';

export async function handleRosterRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (pathname === ROSTER_SEARCH) {
    if (method === 'GET') return handleSearchRoster(query);
    return notFound;
  }

  if (pathname === ROSTER_PREFIX) {
    if (method === 'GET') return handleListRoster(query);
    if (method === 'POST') return handleAddRoster(await readBody(req));
    return notFound;
  }

  if (pathname.startsWith(ROSTER_PREFIX + '/')) {
    const rest = pathname.slice(ROSTER_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 1 && parts[0]) {
      const id = parts[0];
      if (method === 'GET') return handleGetRosterEntry(id);
      if (method === 'PUT') return handleUpdateRoster(id, await readBody(req));
      if (method === 'DELETE') return handleDeleteRoster(id);
      return notFound;
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'alias' && method === 'PUT') {
      return handleSetAlias(parts[0], await readBody(req));
    }
    return notFound;
  }

  return null;
}
