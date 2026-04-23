import { httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const requestOfflineSchema = {
  name: 'request_offline',
  description:
    'Leader-only. Approve a member to go offline. Pushes target instance from ACTIVE to PENDING_OFFLINE and notifies them via comm.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      instanceId: {
        type: 'string',
        description: 'Target member role_instances.id',
      },
    },
    required: ['instanceId'],
    additionalProperties: false,
  },
};

export async function runRequestOffline(
  env: MteamEnv,
  args: { instanceId?: unknown },
): Promise<unknown> {
  const targetId = typeof args.instanceId === 'string' ? args.instanceId : '';
  if (!targetId) {
    return { error: 'instanceId is required' };
  }
  const url = `${env.hubUrl}/api/role-instances/${encodeURIComponent(targetId)}/request-offline`;
  const res = await httpJson(url, {
    method: 'POST',
    headers: { 'X-Role-Instance-Id': env.instanceId },
    body: JSON.stringify({ callerInstanceId: env.instanceId }),
  });
  if (!res.ok) {
    return { error: res.error ?? `request_offline failed (HTTP ${res.status})` };
  }
  return res.body ?? { status: 'PENDING_OFFLINE' };
}
