// mteam-primary · search_settings
// 模糊搜索全局设置注册表。返回命中条目的 key / label / description / schema / currentValue。

import { settingsRegistry } from '../../settings/registry.js';
import type { SearchResult } from '../../settings/types.js';

export const searchSettingsSchema = {
  name: 'search_settings',
  description:
    'Search system settings by keyword. Returns matching settings with current values and schema.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Search keyword' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['q'],
    additionalProperties: false,
  },
};

export interface SearchSettingsArgs {
  q?: unknown;
  limit?: unknown;
}

export async function runSearchSettings(
  args: SearchSettingsArgs,
  deps: { registry?: { search: (q: string, limit?: number) => SearchResult[] } } = {},
): Promise<{ results: SearchResult[] }> {
  const q = typeof args.q === 'string' ? args.q : '';
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
  const registry = deps.registry ?? settingsRegistry;
  return { results: registry.search(q, limit) };
}
