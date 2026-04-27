import { describe, it, expect } from 'bun:test';
import { scoreEntry } from './search-score.js';
import type { SettingEntry } from './types.js';

function entry(partial: Partial<SettingEntry>): SettingEntry {
  return {
    key: partial.key ?? 'x',
    label: partial.label ?? '',
    description: partial.description ?? '',
    category: partial.category ?? 'misc',
    schema: {},
    readonly: false,
    notify: 'none',
    getter: () => null,
    setter: () => {},
    keywords: partial.keywords,
    ...partial,
  };
}

describe('scoreEntry', () => {
  it('label 命中得高分', () => {
    const e = entry({ label: '系统提示词', description: '' });
    expect(scoreEntry(e, '系统提示词')).toBeGreaterThan(0);
  });

  it('key 精确匹配比 description 命中分数更高', () => {
    const a = entry({
      key: 'primary-agent.systemPrompt',
      label: '无关',
      description: '',
    });
    const b = entry({
      key: 'other',
      label: '无关',
      description: 'primary-agent.systemPrompt',
    });
    expect(scoreEntry(a, 'systemPrompt')).toBeGreaterThan(
      scoreEntry(b, 'systemPrompt'),
    );
  });

  it('完全不匹配返回 0', () => {
    const e = entry({ label: 'avatar', description: '头像', category: 'ui' });
    expect(scoreEntry(e, '无关词xyzzy')).toBe(0);
  });

  it('空 query 返回 0', () => {
    const e = entry({ label: 'anything' });
    expect(scoreEntry(e, '')).toBe(0);
  });

  it('多 token 部分命中仍有分', () => {
    const e = entry({ label: '主 Agent 名称', description: '名字' });
    const s = scoreEntry(e, '主 Agent');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('keywords 命中加分', () => {
    const withKw = entry({
      label: 'X',
      description: '',
      keywords: ['sandbox', 'container'],
    });
    const withoutKw = entry({ label: 'X', description: '' });
    expect(scoreEntry(withKw, 'sandbox')).toBeGreaterThan(
      scoreEntry(withoutKw, 'sandbox'),
    );
  });

  it('分数不会超过 1', () => {
    const e = entry({
      key: 'full',
      label: 'full',
      description: 'full',
      category: 'full',
      keywords: ['full'],
    });
    expect(scoreEntry(e, 'full')).toBeLessThanOrEqual(1);
  });
});
