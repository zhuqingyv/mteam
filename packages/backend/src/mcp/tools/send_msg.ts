import { runLookup } from './lookup.js';
import type { CommClient } from '../comm-client.js';
import type { MteamEnv } from '../config.js';

export const sendMsgSchema = {
  name: 'send_msg',
  description:
    'Send a message to another agent. "to" accepts an address (e.g. "local:<id>"), an alias/member_name, or an instanceId. Multiple matches → error.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Target: address, alias, member_name, or instanceId.' },
      summary: { type: 'string', maxLength: 200, description: 'Short summary.' },
      content: { type: 'string', description: 'Full message body.' },
    },
    required: ['to', 'summary', 'content'],
    additionalProperties: false,
  },
};

function isAddress(s: string): boolean {
  const colon = s.indexOf(':');
  return colon > 0 && colon < s.length - 1;
}

export async function runSendMsg(
  env: MteamEnv,
  comm: CommClient,
  args: { to?: unknown; summary?: unknown; content?: unknown },
): Promise<unknown> {
  const to = typeof args.to === 'string' ? args.to : '';
  const summary = typeof args.summary === 'string' ? args.summary : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!to) return { error: 'to is required' };
  if (!summary) return { error: 'summary is required' };
  if (!content) return { error: 'content is required' };

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

  try {
    await comm.send({ to: address, payload: { summary, content } });
  } catch (e) {
    return { error: `send failed: ${(e as Error).message}` };
  }
  return { delivered: true, to: address };
}
