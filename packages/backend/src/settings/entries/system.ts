// 系统级配置入口。首批一条：system.maxAgents（角色实例并发上限）。
// 存储走 src/system/quota-config.ts 的 readMaxAgents / writeMaxAgents，
// 背后是 system_configs(key, value_json) 表。

import type { SettingEntry } from '../types.js';
import { readMaxAgents, writeMaxAgents } from '../../system/quota-config.js';

export const systemEntries: SettingEntry[] = [
  {
    key: 'system.maxAgents',
    label: 'Agent 上限',
    description:
      '同时存活的角色实例总数上限（含 PENDING/ACTIVE/PENDING_OFFLINE）。超限时 create_leader / add_member 返回 QUOTA_EXCEEDED。',
    category: 'system',
    schema: { type: 'number', minimum: 1, maximum: 500 },
    readonly: false,
    notify: 'primary',
    keywords: ['quota', 'limit', '并发', '上限', '配额', 'agent'],
    getter: () => readMaxAgents(),
    setter: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
        throw new Error('system.maxAgents must be integer in [1, 500]');
      }
      writeMaxAgents(value);
    },
  },
];
