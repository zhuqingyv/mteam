import { describe, it, expect } from 'bun:test';
import { SettingsRegistry } from '../../settings/registry.js';
import type { SettingEntry } from '../../settings/types.js';
import { runCallSetting, callSettingSchema } from './call_setting.js';

function mkEntry(key: string, readonly: boolean): SettingEntry {
  let stored: unknown = 'init';
  return {
    key, label: key, description: '', category: 't', schema: { type: 'string' },
    readonly, notify: 'none',
    getter: () => (readonly ? 'locked' : stored),
    setter: (v) => { if (readonly) throw new Error('never'); stored = v; },
  };
}
function reg(entries: SettingEntry[] = []): SettingsRegistry {
  const r = new SettingsRegistry();
  for (const e of entries) r.register(e);
  return r;
}

describe('call_setting', () => {
  it('schema 必填 key+mode、enum=[direct,show]', () => {
    const s = callSettingSchema.inputSchema as {
      required: string[]; properties: { mode: { enum: readonly string[] } };
    };
    expect(s.required).toEqual(['key', 'mode']);
    expect(s.properties.mode.enum).toEqual(['direct', 'show']);
  });

  it('mode=direct 成功写入', async () => {
    const res = await runCallSetting(
      { key: 'x', mode: 'direct', value: 'v' }, { registry: reg([mkEntry('x', false)]) });
    expect(res.ok).toBe(true);
    expect(res.oldValue).toBe('init');
    expect(res.newValue).toBe('v');
  });

  it('mode=direct readonly → error', async () => {
    const res = await runCallSetting(
      { key: 'r', mode: 'direct', value: 'v' }, { registry: reg([mkEntry('r', true)]) });
    expect(res.error).toBe('readonly');
  });

  it('mode=direct not_found / 缺 value → error', async () => {
    const r1 = await runCallSetting({ key: 'm', mode: 'direct', value: 'v' }, { registry: reg() });
    expect(r1.error).toBe('not_found');
    const r2 = await runCallSetting(
      { key: 'x', mode: 'direct' }, { registry: reg([mkEntry('x', false)]) });
    expect(r2.error).toBe('value required for mode=direct');
  });

  it('mode=show 推送并返回 { opened: true }', async () => {
    const pushed: Record<string, unknown>[] = [];
    const res = await runCallSetting(
      { key: 'x', mode: 'show', reason: 'why' },
      { registry: reg([mkEntry('x', false)]), pushToUser: (m) => pushed.push(m) });
    expect(res).toEqual({ opened: true });
    expect(pushed).toEqual([{ type: 'show_setting', key: 'x', reason: 'why' }]);
  });

  it('mode=show not_found 不推送', async () => {
    const pushed: unknown[] = [];
    const res = await runCallSetting(
      { key: 'm', mode: 'show' }, { registry: reg(), pushToUser: (m) => pushed.push(m) });
    expect(res.error).toBe('not_found');
    expect(pushed.length).toBe(0);
  });

  it('缺 key / mode 非法均返 error', async () => {
    const a = await runCallSetting({ mode: 'direct', value: 'v' }, { registry: reg() });
    expect(a.error).toBe('key is required');
    const b = await runCallSetting({ key: 'x', mode: 'garbage' }, { registry: reg() });
    expect(b.error).toBe('mode must be "direct" or "show"');
  });
});
