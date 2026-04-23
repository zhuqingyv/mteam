import { buildQuery, httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';

export const checkInboxSchema = {
  name: 'check_inbox',
  description:
    'Pull unread messages from V2 server. peek=false (default) marks them read; peek=true only previews.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      peek: {
        type: 'boolean',
        default: false,
        description: 'If true, does NOT mark messages as read.',
      },
    },
    additionalProperties: false,
  },
};

export async function runCheckInbox(
  env: MteamEnv,
  args: { peek?: unknown },
): Promise<unknown> {
  const peek = args.peek === true;
  const qs = buildQuery({ peek });
  const url = `${env.hubUrl}/api/role-instances/${encodeURIComponent(env.instanceId)}/inbox${qs}`;
  const res = await httpJson(url, { method: 'GET' });
  if (!res.ok) {
    return { error: res.error ?? `check_inbox failed (HTTP ${res.status})` };
  }
  return res.body ?? { messages: [] };
}
