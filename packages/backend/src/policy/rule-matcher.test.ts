import { describe, it, expect } from 'vitest';
import { matchPattern, evaluate } from './rule-matcher.js';

describe('matchPattern', () => {
  it('精确命中', () => {
    expect(matchPattern('Bash', 'Bash')).toBe(true);
  });

  it('精确不命中', () => {
    expect(matchPattern('Bash', 'Read')).toBe(false);
  });

  it('末位通配命中', () => {
    expect(matchPattern('mcp__mteam__*', 'mcp__mteam__search')).toBe(true);
  });

  it('末位通配不命中前缀以外', () => {
    expect(matchPattern('mcp__mteam__*', 'mcp__other__search')).toBe(false);
  });

  it('大小写敏感', () => {
    expect(matchPattern('Bash', 'bash')).toBe(false);
  });

  it('单独 * 匹配一切', () => {
    expect(matchPattern('*', 'anything')).toBe(true);
    expect(matchPattern('*', '')).toBe(true);
  });

  it('中间的 * 不识别为通配，退化为精确匹配', () => {
    expect(matchPattern('mcp__*__search', 'mcp__mteam__search')).toBe(false);
    expect(matchPattern('mcp__*__search', 'mcp__*__search')).toBe(true);
  });

  it('前缀末位通配也需前缀完全相等', () => {
    expect(matchPattern('mcp__mteam__*', 'mcp__mteam_')).toBe(false);
    expect(matchPattern('mcp__mteam__*', 'mcp__mteam__')).toBe(true);
  });
});

describe('evaluate', () => {
  it('空规则 → no_match', () => {
    expect(evaluate('Bash', { allow: [], deny: [] })).toEqual({
      verdict: 'no_match',
      matchedPattern: null,
    });
  });

  it('仅 allow 命中 → allow 并带匹配模式', () => {
    expect(evaluate('Bash', { allow: ['Bash'], deny: [] })).toEqual({
      verdict: 'allow',
      matchedPattern: 'Bash',
    });
  });

  it('仅 deny 命中 → deny', () => {
    expect(evaluate('Bash', { allow: [], deny: ['Bash'] })).toEqual({
      verdict: 'deny',
      matchedPattern: 'Bash',
    });
  });

  it('deny 优先级高于 allow（两者都命中时返回 deny）', () => {
    const res = evaluate('Bash', { allow: ['Bash', '*'], deny: ['Bash'] });
    expect(res.verdict).toBe('deny');
    expect(res.matchedPattern).toBe('Bash');
  });

  it('通配 allow 命中', () => {
    const res = evaluate('mcp__mteam__search', {
      allow: ['mcp__mteam__*'],
      deny: [],
    });
    expect(res.verdict).toBe('allow');
    expect(res.matchedPattern).toBe('mcp__mteam__*');
  });

  it('通配 deny 命中，未命中 allow → deny', () => {
    const res = evaluate('mcp__danger__drop', {
      allow: ['mcp__safe__*'],
      deny: ['mcp__danger__*'],
    });
    expect(res.verdict).toBe('deny');
    expect(res.matchedPattern).toBe('mcp__danger__*');
  });

  it('都不命中 → no_match', () => {
    const res = evaluate('Unknown', {
      allow: ['Bash'],
      deny: ['Dangerous'],
    });
    expect(res).toEqual({ verdict: 'no_match', matchedPattern: null });
  });

  it('* 作为 allow 放行一切（但 deny 仍优先）', () => {
    expect(evaluate('X', { allow: ['*'], deny: [] }).verdict).toBe('allow');
    expect(evaluate('X', { allow: ['*'], deny: ['X'] }).verdict).toBe('deny');
  });
});
