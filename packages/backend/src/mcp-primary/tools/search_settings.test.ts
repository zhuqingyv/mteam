import { describe, it, expect } from 'bun:test';
import { SettingsRegistry } from '../../settings/registry.js';
import type { SettingEntry } from '../../settings/types.js';
import { runSearchSettings, searchSettingsSchema } from './search_settings.js';

function fakeEntry(key: string, label: string, description = ''): SettingEntry {
  let stored: unknown = key;
  return {
    key, label, description,
    category: 'test',
    schema: { type: 'string' },
    readonly: false,
    notify: 'none',
    getter: () => stored,
    setter: (v) => { stored = v; },
  };
}

function makeRegistry(): SettingsRegistry {
  const r = new SettingsRegistry();
  r.register(fakeEntry('primary-agent.systemPrompt', '系统提示词', '主 Agent 系统提示'));
  r.register(fakeEntry('notification.mode', '通知模式', 'proxy or direct'));
  r.register(fakeEntry('cli.claude.version', 'Claude 版本'));
  return r;
}

describe('search_settings', () => {
  it('schema 必填 q、additionalProperties=false', () => {
    const s = searchSettingsSchema.inputSchema as { required: string[]; additionalProperties: boolean };
    expect(s.required).toEqual(['q']);
    expect(s.additionalProperties).toBe(false);
  });

  it('命中关键词返回匹配条目', async () => {
    const res = await runSearchSettings({ q: '系统提示' }, { registry: makeRegistry() });
    expect(res.results[0].key).toBe('primary-agent.systemPrompt');
  });

  it('空字符串返回全部条目', async () => {
    const res = await runSearchSettings({ q: '' }, { registry: makeRegistry() });
    expect(res.results.length).toBe(3);
  });

  it('limit 生效', async () => {
    const res = await runSearchSettings({ q: '', limit: 2 }, { registry: makeRegistry() });
    expect(res.results.length).toBe(2);
  });

  it('未命中返回空数组', async () => {
    const res = await runSearchSettings({ q: 'xyzzz' }, { registry: makeRegistry() });
    expect(res.results).toEqual([]);
  });
});
