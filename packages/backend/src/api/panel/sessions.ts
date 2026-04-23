import { RoleInstance } from '../../domain/role-instance.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function handleRegisterSession(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');

  const instanceId = body.instanceId;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return errRes(400, 'instanceId is required');
  }

  const instance = RoleInstance.findById(instanceId);
  if (!instance) return errRes(404, `role instance '${instanceId}' not found`);

  if (body.claudeSessionId !== undefined && body.claudeSessionId !== null) {
    if (typeof body.claudeSessionId !== 'string' || body.claudeSessionId.length === 0) {
      return errRes(400, 'claudeSessionId must be a non-empty string');
    }
    instance.setClaudeSessionId(body.claudeSessionId);
  }

  if (instance.status === 'PENDING') {
    instance.activate(null);
  }

  return { status: 200, body: { status: instance.status } };
}
