// 主 Agent 6 项设置。getter/setter 转发到 primary-agent/repo.ts 的 readRow / upsertConfig。
// 空库状态下 getter 返回 null，setter 由 upsertConfig 自身兜底首次插入。

import type { SettingEntry } from '../types.js';
import { readRow, upsertConfig } from '../../primary-agent/repo.js';
import type { McpToolVisibility } from '../../domain/role-template.js';

const CATEGORY = 'primary-agent';
const NOTIFY = 'primary' as const;

export const primaryAgentEntries: SettingEntry[] = [
  {
    key: 'primary-agent.name',
    label: '主Agent名称',
    description: '主Agent的显示名称',
    category: CATEGORY,
    schema: { type: 'string', minLength: 1, maxLength: 64 },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.name ?? null,
    setter: (value: unknown) => {
      upsertConfig({ name: value as string });
    },
  },
  {
    key: 'primary-agent.cliType',
    label: 'CLI类型',
    description: '主Agent使用的底层 CLI（claude 或 codex）',
    category: CATEGORY,
    schema: { type: 'string', enum: ['claude', 'codex'] },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.cliType ?? null,
    setter: (value: unknown) => {
      upsertConfig({ cliType: value as string });
    },
  },
  {
    key: 'primary-agent.systemPrompt',
    label: '主Agent提示词',
    description: '主Agent的系统提示词（身份、职责、口径）',
    category: CATEGORY,
    schema: { type: 'string' },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.systemPrompt ?? null,
    setter: (value: unknown) => {
      upsertConfig({ systemPrompt: value as string });
    },
  },
  {
    key: 'primary-agent.mcpConfig',
    label: '主Agent MCP配置',
    description: '主Agent可访问的 MCP 工具可见性列表',
    category: CATEGORY,
    schema: { type: 'array' },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.mcpConfig ?? null,
    setter: (value: unknown) => {
      upsertConfig({ mcpConfig: value as McpToolVisibility[] });
    },
  },
  {
    key: 'primary-agent.sandbox',
    label: '沙箱模式',
    description: 'true=走 DockerRuntime 容器隔离；false=HostRuntime 直跑',
    category: CATEGORY,
    schema: { type: 'boolean' },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.sandbox ?? null,
    setter: (value: unknown) => {
      upsertConfig({ sandbox: value as boolean });
    },
  },
  {
    key: 'primary-agent.autoApprove',
    label: '自动批准权限',
    description: 'true=ACP requestPermission 自动 allow；false=一律 cancelled',
    category: CATEGORY,
    schema: { type: 'boolean' },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.autoApprove ?? null,
    setter: (value: unknown) => {
      upsertConfig({ autoApprove: value as boolean });
    },
  },
];
