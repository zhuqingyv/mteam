// 系统级配置入口。首批一条：system.maxAgents（角色实例并发上限）。
// 存储走 src/system/quota-config.ts 的 readMaxAgents / writeMaxAgents，
// 背后是 system_configs(key, value_json) 表。

import type { SettingEntry } from '../types.js';
import { readMaxAgents, writeMaxAgents } from '../../system/quota-config.js';
import {
  readDefaultPermissionMode,
  writeDefaultPermissionMode,
} from '../../system/permission-config.js';

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
  {
    key: 'system.defaultPermissionMode',
    label: '默认权限模式',
    description: 'auto=全自动批准 ACP 权限；manual=半自动（透传前端让用户确认）。实例级 permissionMode 优先级高于此默认。',
    category: 'system',
    schema: { type: 'string', enum: ['auto', 'manual'] },
    readonly: false,
    notify: 'none',
    keywords: ['permission', 'auto', 'manual', '权限', '审批', '自动', '半自动'],
    getter: () => readDefaultPermissionMode(),
    setter: (value: unknown) => {
      if (value !== 'auto' && value !== 'manual') {
        throw new Error('system.defaultPermissionMode must be "auto" or "manual"');
      }
      writeDefaultPermissionMode(value);
    },
  },
];
