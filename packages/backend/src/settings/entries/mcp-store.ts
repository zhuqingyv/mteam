// MCP 工具商店入口。install/uninstall 走商店接口，这里只注册 readonly 根条目。

import type { SettingEntry } from '../types.js';
import { listAll as listAllMcps } from '../../mcp-store/store.js';

export const mcpStoreEntries: SettingEntry[] = [
  {
    key: 'mcp-store',
    label: 'MCP工具商店',
    description: '已安装的 MCP 工具列表（command / args / env / transport）。install/uninstall 走商店接口。',
    category: 'mcp-store',
    schema: { type: 'array' },
    readonly: true,
    notify: 'none',
    keywords: ['mcp', '工具', 'store', '商店', 'tool'],
    getter: () => listAllMcps(),
    setter: () => {
      throw new Error('readonly: mcp-store is managed via /api/panel/mcp/store');
    },
  },
];
