import { buildQuery, httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';
import type { InboxSummary } from '../../comm/message-store.js';

export const checkInboxSchema = {
  name: 'check_inbox',
  description:
    'Pull unread message summaries (no content) from V2 server. peek=false (default) marks them read; peek=true only previews. Use read_message with msg_id to fetch full envelope.',
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

export type CheckInboxResult =
  | { messages: InboxSummary[]; total: number }
  | { error: string };

export async function runCheckInbox(
  env: MteamEnv,
  args: { peek?: unknown },
): Promise<CheckInboxResult> {
  const peek = args.peek === true;
  const qs = buildQuery({ peek });
  const url = `${env.hubUrl}/api/role-instances/${encodeURIComponent(env.instanceId)}/inbox${qs}`;
  const res = await httpJson<{ messages?: InboxSummary[]; total?: number }>(url, { method: 'GET' });
  if (!res.ok) {
    return { error: res.error ?? `check_inbox failed (HTTP ${res.status})` };
  }
  const messages = Array.isArray(res.body?.messages) ? res.body!.messages! : [];
  const total = typeof res.body?.total === 'number' ? res.body!.total! : messages.length;
  return { messages, total };
}
