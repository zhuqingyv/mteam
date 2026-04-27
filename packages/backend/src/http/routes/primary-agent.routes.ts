// > 前端请走 /api/panel/primary-agent/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  handleGetPrimaryAgent,
  handleConfigurePrimaryAgent,
  handleStartPrimaryAgent,
  handleStopPrimaryAgent,
} from '../../api/panel/primary-agent.js';
import { readBody, notFound } from '../http-utils.js';

const PRIMARY_AGENT_PREFIX = '/api/primary-agent';
const PRIMARY_AGENT_CONFIG = '/api/primary-agent/config';
const PRIMARY_AGENT_START = '/api/primary-agent/start';
const PRIMARY_AGENT_STOP = '/api/primary-agent/stop';

export async function handlePrimaryAgentRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
): Promise<ApiResponse | null> {
  if (pathname === PRIMARY_AGENT_CONFIG) {
    if (method === 'POST') return handleConfigurePrimaryAgent(await readBody(req));
    return notFound;
  }
  if (pathname === PRIMARY_AGENT_START) {
    if (method === 'POST') return handleStartPrimaryAgent();
    return notFound;
  }
  if (pathname === PRIMARY_AGENT_STOP) {
    if (method === 'POST') return handleStopPrimaryAgent();
    return notFound;
  }
  if (pathname === PRIMARY_AGENT_PREFIX) {
    if (method === 'GET') return handleGetPrimaryAgent();
    return notFound;
  }
  return null;
}
