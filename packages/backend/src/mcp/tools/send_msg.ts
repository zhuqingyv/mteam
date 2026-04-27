import { runLookup } from './lookup.js';
import type { CommLike } from '../comm-like.js';
import type { MteamEnv } from '../config.js';

const ALLOWED_KINDS = ['chat', 'task'] as const;
type AllowedKind = (typeof ALLOWED_KINDS)[number];

export const sendMsgSchema = {
  name: 'send_msg',
  description:
    'Send a message to another agent. "to" accepts an address (e.g. "local:<id>"), an alias/member_name, or an instanceId. Multiple matches → error.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Target: address, alias, member_name, or instanceId.' },
      summary: { type: 'string', maxLength: 200, description: 'Short summary. Defaults to "给你发了一条消息" when omitted.' },
      content: { type: 'string', description: 'Full message body.' },
      kind: { type: 'string', enum: ALLOWED_KINDS, description: 'Message kind; defaults to "chat". system/broadcast are not allowed from this tool.' },
      replyTo: { type: 'string', description: 'Optional envelope id this message replies to.' },
    },
    required: ['to', 'content'],
    additionalProperties: false,
  },
};

function isAddress(s: string): boolean {
  const colon = s.indexOf(':');
  return colon > 0 && colon < s.length - 1;
}

export async function runSendMsg(
  env: MteamEnv,
  comm: CommLike,
  args: { to?: unknown; summary?: unknown; content?: unknown; kind?: unknown; replyTo?: unknown },
): Promise<unknown> {
  const to = typeof args.to === 'string' ? args.to : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!to) return { error: 'to is required' };
  if (!content) return { error: 'content is required' };
  const summary = typeof args.summary === 'string' && args.summary.length > 0 ? args.summary : '给你发了一条消息';
  let kind: AllowedKind = 'chat';
  if (args.kind !== undefined) {
    if (typeof args.kind !== 'string' || !(ALLOWED_KINDS as readonly string[]).includes(args.kind)) {
      return { error: `kind must be one of ${ALLOWED_KINDS.join('/')}` };
    }
    kind = args.kind as AllowedKind;
  }
  const replyTo = typeof args.replyTo === 'string' && args.replyTo.length > 0 ? args.replyTo : undefined;

  let address: string;
  if (isAddress(to)) {
    address = to;
  } else {
    const res = await runLookup(env, { query: to });
    if ('error' in res) return { error: `lookup failed: ${res.error}` };
    if (res.match === 'none') return { error: `no member matches '${to}'` };
    if (res.match === 'multiple') {
      const names = res.candidates.map((c) => c.alias).join(', ');
      return { error: `multiple matches for '${to}': ${names}` };
    }
    address = res.target.address;
  }

  const payload: Record<string, unknown> = { summary, content, kind };
  if (replyTo !== undefined) payload.replyTo = replyTo;
  try {
    await comm.send({ to: address, payload });
  } catch (e) {
    return { error: `send failed: ${(e as Error).message}` };
  }
  return { delivered: true, to: address };
}
