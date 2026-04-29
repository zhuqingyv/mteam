// mteam-primary · search_settings
// 模糊搜索全局设置注册表。返回命中条目的 key / label / description / schema / currentValue。

import { settingsRegistry } from '../../settings/registry.js';
import type { SearchResult } from '../../settings/types.js';

export const searchSettingsSchema = {
  name: 'search_settings',
  description:
    '按关键字搜索系统设置项（比如岗位模板、团队配置等），返回命中项的当前值和说明。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: '搜索关键字。' },
      limit: { type: 'number', description: '最多返回几条（默认 20）。' },
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
