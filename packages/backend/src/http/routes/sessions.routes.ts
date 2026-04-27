import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { handleRegisterSession } from '../../api/panel/sessions.js';
import { readBody, notFound } from '../http-utils.js';

const SESSIONS_REGISTER = '/api/sessions/register';

export async function handleSessionsRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
): Promise<ApiResponse | null> {
  if (pathname === SESSIONS_REGISTER) {
    if (method === 'POST') return handleRegisterSession(await readBody(req));
    return notFound;
  }
  return null;
}
