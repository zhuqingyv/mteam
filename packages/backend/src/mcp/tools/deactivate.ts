import { httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const deactivateSchema = {
  name: 'deactivate',
  description:
    'Leave the team. Requires leader to have approved offline first (status must be PENDING_OFFLINE). Otherwise returns an error.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};

export async function runDeactivate(env: MteamEnv): Promise<unknown> {
  const url = `${env.hubUrl}/api/role-instances/${encodeURIComponent(env.instanceId)}`;
  const res = await httpJson(url, {
    method: 'DELETE',
    headers: { 'X-Role-Instance-Id': env.instanceId },
  });
  if (!res.ok) {
    return { error: res.error ?? `deactivate failed (HTTP ${res.status})` };
  }
  return { status: 'deleted' };
}
