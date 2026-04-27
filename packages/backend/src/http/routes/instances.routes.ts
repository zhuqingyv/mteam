// > 前端请走 /api/panel/instances/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  handleCreateInstance,
  handleListInstances,
  handleDeleteInstance,
  handleActivate,
  handleRequestOffline,
} from '../../api/panel/role-instances.js';
import { readBody, notFound } from '../http-utils.js';

const INSTANCES_PREFIX = '/api/role-instances';

export async function handleInstancesRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (pathname === INSTANCES_PREFIX) {
    if (method === 'GET') return handleListInstances();
    if (method === 'POST') return handleCreateInstance(await readBody(req));
    return notFound;
  }

  if (pathname.startsWith(INSTANCES_PREFIX + '/')) {
    const rest = pathname.slice(INSTANCES_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 1 && parts[0]) {
      if (method === 'DELETE') return handleDeleteInstance(parts[0], query.get('force') === '1');
      return notFound;
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
    return notFound;
  }

  return null;
}
