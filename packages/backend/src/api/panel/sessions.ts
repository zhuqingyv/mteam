import { RoleInstance } from '../../domain/role-instance.js';
import { bus } from '../../bus/index.js';
import { makeBase } from '../../bus/helpers.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// emit 事件让 roster subscriber 自动同步状态（修复旧版 activate 后 roster 未更新的 bug）。
export function handleRegisterSession(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');

  const instanceId = body.instanceId;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return errRes(400, 'instanceId is required');
  }

  const instance = RoleInstance.findById(instanceId);
  if (!instance) return errRes(404, `role instance '${instanceId}' not found`);

  let sessionRegistered = false;
  if (body.claudeSessionId !== undefined && body.claudeSessionId !== null) {
    if (typeof body.claudeSessionId !== 'string' || body.claudeSessionId.length === 0) {
      return errRes(400, 'claudeSessionId must be a non-empty string');
    }
    instance.setClaudeSessionId(body.claudeSessionId);
    sessionRegistered = true;
  }

  const wasPending = instance.status === 'PENDING';
  if (wasPending) {
    instance.activate(null);
  }

  if (wasPending) {
    bus.emit({
      ...makeBase('instance.activated', 'api:sessions'),
      instanceId,
      actor: null,
    });
  }

  if (sessionRegistered) {
    bus.emit({
      ...makeBase('instance.session_registered', 'api:sessions'),
      instanceId,
      claudeSessionId: body.claudeSessionId as string,
    });
  }

  return { status: 200, body: { status: instance.status } };
}
