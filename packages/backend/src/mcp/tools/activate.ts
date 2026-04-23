import { httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const activateSchema = {
  name: 'activate',
  description:
    'Activate self (PENDING → ACTIVE). Must be the very first call after the agent CLI starts. Returns persona/task/leaderName.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};

export async function runActivate(env: MteamEnv): Promise<unknown> {
  const url = `${env.hubUrl}/api/role-instances/${encodeURIComponent(env.instanceId)}/activate`;
  const res = await httpJson(url, { method: 'POST', body: JSON.stringify({}) });
  if (!res.ok) {
    return { error: res.error ?? `activate failed (HTTP ${res.status})` };
  }
  return res.body ?? { status: 'ACTIVE' };
}
