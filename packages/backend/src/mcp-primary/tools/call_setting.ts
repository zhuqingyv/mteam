// mteam-primary · call_setting
// 统一调用入口：mode=direct 直接写值；mode=show fire-and-forget 给用户弹设置面板。

import { settingsRegistry } from '../../settings/registry.js';
import type { SettingsRegistry } from '../../settings/registry.js';

export const callSettingSchema = {
  name: 'call_setting',
  description:
    '操作某个系统设置项：mode=direct 直接改值；mode=show 打开设置面板让用户自己改。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key: { type: 'string', description: '设置项的 key（从 search_settings 的结果里拿）。' },
      mode: { type: 'string', enum: ['direct', 'show'], description: 'direct 直接改；show 打开设置面板。' },
      value: { description: 'mode=direct 时必填，新的值。' },
      reason: { type: 'string', description: 'mode=show 时可选，告诉用户为什么要改这项。' },
    },
    required: ['key', 'mode'],
    additionalProperties: false,
  },
};

export interface CallSettingArgs {
  key?: unknown;
  mode?: unknown;
  value?: unknown;
  reason?: unknown;
}

export interface CallSettingDeps {
  registry?: SettingsRegistry;
  pushToUser?: (msg: Record<string, unknown>) => void;
}

export async function runCallSetting(
  args: CallSettingArgs,
  deps: CallSettingDeps = {},
): Promise<Record<string, unknown>> {
  const key = typeof args.key === 'string' ? args.key : '';
  const mode = args.mode === 'direct' || args.mode === 'show' ? args.mode : null;
  if (!key) return { error: 'key is required' };
  if (!mode) return { error: 'mode must be "direct" or "show"' };

  const registry = deps.registry ?? settingsRegistry;

  if (mode === 'direct') {
    if (args.value === undefined) return { error: 'value required for mode=direct' };
    const result = registry.write(key, args.value, { kind: 'agent', id: 'primary' });
    return result as unknown as Record<string, unknown>;
  }

  // mode === 'show'
  const entry = registry.get(key);
  if (!entry) return { error: 'not_found' };
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  if (deps.pushToUser) {
    deps.pushToUser({ type: 'show_setting', key, ...(reason ? { reason } : {}) });
  }
  return { opened: true };
}
