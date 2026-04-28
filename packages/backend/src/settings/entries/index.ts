// 汇总所有业务模块的 Settings entry 注册。registry 装配时一次性展开这个数组。

import type { SettingEntry } from '../types.js';
import { primaryAgentEntries } from './primary-agent.js';
import { templateEntries } from './templates.js';
import { avatarEntries } from './avatars.js';
import { mcpStoreEntries } from './mcp-store.js';
import { notificationEntries } from './notification.js';
import { systemEntries } from './system.js';

export const ALL_SETTING_ENTRIES: SettingEntry[] = [
  ...primaryAgentEntries,
  ...templateEntries,
  ...avatarEntries,
  ...mcpStoreEntries,
  ...notificationEntries,
  ...systemEntries,
];
