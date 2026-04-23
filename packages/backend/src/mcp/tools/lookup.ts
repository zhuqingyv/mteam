import { buildQuery, httpJson } from '../http-client.js';
import type { MteamEnv } from '../config.js';
import type { SearchResult } from '../../roster/types.js';

export const lookupSchema = {
  name: 'lookup',
  description:
    'Find a communication target by fuzzy alias/member_name match. Optional scope: team | local | remote.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keyword; fuzzy-matches alias (falls back to member_name).',
      },
      scope: {
        type: 'string',
        enum: ['team', 'local', 'remote'],
        description: 'Optional search scope.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export async function runLookup(
  env: MteamEnv,
  args: { query?: unknown; scope?: unknown },
): Promise<SearchResult | { error: string }> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return { error: 'query is required' };
  const scope = typeof args.scope === 'string' ? args.scope : undefined;
  const qs = buildQuery({
    q: query,
    scope,
    callerInstanceId: env.instanceId,
  });
  const url = `${env.hubUrl}/api/roster/search${qs}`;
  const res = await httpJson<SearchResult>(url, { method: 'GET' });
  if (!res.ok) {
    return { error: res.error ?? `lookup failed (HTTP ${res.status})` };
  }
  return (res.body as SearchResult) ?? { match: 'none', query };
}
