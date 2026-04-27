// 头像库入口。增删走 /api/panel/avatars/*，这里只注册 readonly 根条目。

import type { SettingEntry } from '../types.js';
import { listAll as listAllAvatars } from '../../avatar/repo.js';

export const avatarEntries: SettingEntry[] = [
  {
    key: 'avatars',
    label: '头像库',
    description: '所有可用头像（内置 + 自定义）。增删走头像库接口。',
    category: 'avatars',
    schema: { type: 'array' },
    readonly: true,
    notify: 'none',
    keywords: ['头像', 'avatar', 'icon'],
    getter: () => listAllAvatars(),
    setter: () => {
      throw new Error('readonly: avatars are managed via /api/panel/avatars/*');
    },
  },
];
