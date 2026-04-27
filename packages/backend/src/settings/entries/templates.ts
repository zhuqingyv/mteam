// 角色模板列表入口。模板本身的 CRUD 走 /api/panel/templates/*，这里只注册
// 一个 readonly 根条目让 agent 能通过 search_settings 定位到"模板管理"能力。
// 不展开每条模板的字段（设计文档 §2 要求入口级粒度，避免太细）。

import type { SettingEntry } from '../types.js';
import { RoleTemplate } from '../../domain/role-template.js';

export const templateEntries: SettingEntry[] = [
  {
    key: 'templates',
    label: '角色模板列表',
    description: '所有角色模板（role / persona / avatar / availableMcps）。CRUD 通过模板接口，不从这里直接写入。',
    category: 'templates',
    schema: { type: 'array' },
    readonly: true,
    notify: 'none',
    keywords: ['角色', '模板', 'role', 'persona', '人设'],
    getter: () => RoleTemplate.listAll().map((t) => ({
      name: t.name,
      role: t.role,
      description: t.description,
      persona: t.persona,
      avatar: t.avatar,
      availableMcps: t.availableMcps,
    })),
    setter: () => {
      throw new Error('readonly: templates list is managed via /api/panel/templates/*');
    },
  },
];
