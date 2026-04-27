// mteam-primary · call_setting
// 统一调用入口：mode=direct 直接写值；mode=show fire-and-forget 给用户弹设置面板。

import { settingsRegistry } from '../../settings/registry.js';
import type { SettingsRegistry } from '../../settings/registry.js';

export const callSettingSchema = {
  name: 'call_setting',
  description:
    'Call a setting: either set it directly (mode=direct) or open the setting panel for the user (mode=show, fire-and-forget).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key: { type: 'string', description: 'Setting key from search_settings results' },
      mode: { type: 'string', enum: ['direct', 'show'] },
      value: { description: 'Required when mode=direct. The new value.' },
      reason: { type: 'string', description: 'Optional when mode=show. Hint shown to user.' },
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
