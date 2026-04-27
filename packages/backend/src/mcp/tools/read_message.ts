import { buildQuery, httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';
import type { MessageEnvelope } from '../../comm/envelope.js';

export const readMessageSchema = {
  name: 'read_message',
  description:
    'Fetch a full message envelope by message ID. By default marks the message as read; set markRead=false to peek.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      messageId: {
        type: 'string',
        description: 'Envelope ID (e.g. "msg_xxx").',
      },
      markRead: {
        type: 'boolean',
        default: true,
        description: 'If false, does NOT mark the message as read.',
      },
    },
    required: ['messageId'],
    additionalProperties: false,
  },
};

export async function runReadMessage(
  env: MteamEnv,
  args: { messageId?: unknown; markRead?: unknown },
): Promise<{ envelope: MessageEnvelope } | { error: string }> {
  const messageId = typeof args.messageId === 'string' ? args.messageId : '';
  if (!messageId) return { error: 'messageId is required' };
  const markRead = args.markRead === false ? false : true;

  const qs = buildQuery({ markRead });
  const url = `${env.hubUrl}/api/messages/${encodeURIComponent(messageId)}${qs}`;
  const res = await httpJson<{ envelope?: MessageEnvelope }>(url, { method: 'GET' });

  if (res.ok) {
    if (res.body && typeof res.body === 'object' && res.body.envelope) {
      return { envelope: res.body.envelope };
    }
    return { error: 'malformed response: missing envelope' };
  }
  if (res.status === 404) return { error: `message not found: ${messageId}` };
  if (res.status === 403) return { error: `forbidden: ${messageId}` };
  return { error: res.error ?? `read_message failed (HTTP ${res.status})` };
}
