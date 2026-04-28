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
    key: 'primary-agent.permissionMode',
    label: '权限审批模式',
    description: 'auto=全自动批准 ACP 权限；manual=半自动（透传前端让用户确认）',
    category: CATEGORY,
    schema: { type: 'string', enum: ['auto', 'manual'] },
    readonly: false,
    notify: NOTIFY,
    getter: () => readRow()?.permissionMode ?? null,
    setter: (value: unknown) => {
      if (value !== 'auto' && value !== 'manual') {
        throw new Error('primary-agent.permissionMode must be "auto" or "manual"');
      }
      upsertConfig({ permissionMode: value });
    },
  },
];
