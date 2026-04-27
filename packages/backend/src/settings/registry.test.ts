import { describe, it, expect, beforeEach } from 'bun:test';
import { SettingsRegistry } from './registry.js';
import type { SettingEntry } from './types.js';

function makeEntry(overrides: Partial<SettingEntry> & { key: string }): SettingEntry {
  let stored: unknown = overrides.getter ? undefined : 'init';
  return {
    key: overrides.key,
    label: overrides.label ?? overrides.key,
    description: overrides.description ?? '',
    category: overrides.category ?? 'misc',
    schema: overrides.schema ?? { type: 'string' },
    readonly: overrides.readonly ?? false,
    notify: overrides.notify ?? 'none',
    getter: overrides.getter ?? (() => stored),
    setter: overrides.setter ?? ((v) => {
      stored = v;
    }),
    keywords: overrides.keywords,
  };
}

describe('SettingsRegistry.register / get', () => {
  let r: SettingsRegistry;
  beforeEach(() => {
    r = new SettingsRegistry();
  });

  it('register 后能通过 get 取回', () => {
    const e = makeEntry({ key: 'a.b' });
    r.register(e);
    expect(r.get('a.b')).toBe(e);
  });

  it('registerAll 批量注册', () => {
    r.registerAll([
      makeEntry({ key: 'a' }),
      makeEntry({ key: 'b' }),
      makeEntry({ key: 'c' }),
    ]);
    expect(r.list()).toHaveLength(3);
  });

  it('get 不存在返回 null', () => {
    expect(r.get('missing')).toBeNull();
  });
});

describe('SettingsRegistry.search', () => {
  let r: SettingsRegistry;
  beforeEach(() => {
    r = new SettingsRegistry();
    r.registerAll([
      makeEntry({
        key: 'primary-agent.systemPrompt',
        label: '系统提示词',
        description: '主 Agent 的 system prompt',
        category: 'primary-agent',
      }),
      makeEntry({
        key: 'primary-agent.cliType',
        label: 'CLI 类型',
        description: 'Claude 或 Codex',
        category: 'primary-agent',
      }),
      makeEntry({
        key: 'templates.x.role',
        label: '角色',
        description: '角色描述',
        category: 'templates',
      }),
    ]);
  });

  it('label 命中会排在前面', () => {
    const results = r.search('系统提示词');
    expect(results[0]?.key).toBe('primary-agent.systemPrompt');
  });

  it('search 返回包含 currentValue', () => {
    const results = r.search('系统提示词');
    expect(results[0]?.currentValue).toBe('init');
  });

  it('不匹配不返回', () => {
    expect(r.search('xyzzy不存在')).toEqual([]);
  });

  it('空 query 返回全部（受 limit 约束）', () => {
    const all = r.search('');
    expect(all).toHaveLength(3);
    const limited = r.search('', 2);
    expect(limited).toHaveLength(2);
  });

  it('limit 生效', () => {
    const results = r.search('', 1);
    expect(results).toHaveLength(1);
  });
});

describe('SettingsRegistry.read / write', () => {
  let r: SettingsRegistry;
  beforeEach(() => {
    r = new SettingsRegistry();
  });

  it('read 调 getter', () => {
    let v = 'hello';
    r.register(
      makeEntry({
        key: 'x',
        getter: () => v,
        setter: (nv) => {
          v = nv as string;
        },
      }),
    );
    expect(r.read('x')).toEqual({ value: 'hello' });
  });

  it('read 不存在返回 null', () => {
    expect(r.read('missing')).toBeNull();
  });

  it('write 调 setter 并返回 old/new', () => {
    let v = 'old';
    r.register(
      makeEntry({
        key: 'x',
        getter: () => v,
        setter: (nv) => {
          v = nv as string;
        },
      }),
    );
    const res = r.write('x', 'new', { kind: 'user', id: 'local' });
    expect(res).toEqual({ ok: true, oldValue: 'old', newValue: 'new' });
    expect(v).toBe('new');
  });

  it('write readonly 返回 error', () => {
    r.register(makeEntry({ key: 'ro', readonly: true }));
    const res = r.write('ro', 'x', { kind: 'user', id: 'local' });
    expect(res).toEqual({ error: 'readonly' });
  });

  it('write 不存在返回 not_found', () => {
    const res = r.write('missing', 'x', { kind: 'user', id: 'local' });
    expect(res).toEqual({ error: 'not_found' });
  });

  it('setter 抛错收敛为 error', () => {
    r.register(
      makeEntry({
        key: 'bad',
        setter: () => {
          throw new Error('boom');
        },
      }),
    );
    const res = r.write('bad', 'x', { kind: 'user', id: 'local' });
    expect(res).toHaveProperty('error');
    if ('error' in res) expect(res.error).toContain('boom');
  });
});
