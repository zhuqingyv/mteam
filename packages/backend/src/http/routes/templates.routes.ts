// > 前端请走 /api/panel/templates/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  handleCreateTemplate,
  handleListTemplates,
  handleGetTemplate,
  handleUpdateTemplate,
  handleDeleteTemplate,
} from '../../api/panel/role-templates.js';
import { readBody, notFound } from '../http-utils.js';

const PREFIX = '/api/role-templates';

export async function handleTemplatesRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
): Promise<ApiResponse | null> {
  if (pathname === PREFIX) {
    if (method === 'GET') return handleListTemplates();
    if (method === 'POST') return handleCreateTemplate(await readBody(req));
    return notFound;
  }

  if (pathname.startsWith(PREFIX + '/')) {
    const rawName = pathname.slice(PREFIX.length + 1);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return { status: 400, body: { error: 'invalid name encoding' } };
    }
    if (!name || name.includes('/')) return notFound;
    if (method === 'GET') return handleGetTemplate(name);
    if (method === 'PUT') return handleUpdateTemplate(name, await readBody(req));
    if (method === 'DELETE') return handleDeleteTemplate(name);
    return notFound;
  }

  return null;
}
