import { describe, expect, test } from 'bun:test';
import { mergeRules } from './rule-merger.js';

describe('mergeRules', () => {
  test('templateAllow=null + 有全局 → configured=false，allow/deny=全局原样', () => {
    const out = mergeRules(null, { allow: ['Read'], deny: ['Bash'] });
    expect(out.configured).toBe(false);
    expect(out.allow).toEqual(['Read']);
    expect(out.deny).toEqual(['Bash']);
  });

  test('templateAllow=[] + 有全局 → configured=true，模板空但仍合入全局 allow', () => {
    const out = mergeRules([], { allow: ['Read'], deny: ['Bash'] });
    expect(out.configured).toBe(true);
    expect(out.allow).toEqual(['Read']);
    expect(out.deny).toEqual(['Bash']);
  });

  test("templateAllow=['Bash'] + 全局 allow=['Read'] → 合并并保序（模板在前）", () => {
    const out = mergeRules(['Bash'], { allow: ['Read'], deny: [] });
    expect(out.configured).toBe(true);
    expect(out.allow).toEqual(['Bash', 'Read']);
    expect(out.deny).toEqual([]);
  });

  test('模板 allow 与全局 allow 有重复 → 合集去重，且全局 deny 本身去重', () => {
    const out = mergeRules(
      ['Read', 'Bash', 'Read'],
      { allow: ['Bash', 'mcp__mteam__*'], deny: ['Kill', 'Kill'] },
    );
    expect(out.allow).toEqual(['Read', 'Bash', 'mcp__mteam__*']);
    expect(out.deny).toEqual(['Kill']);
  });

  test('全局为空 → allow 恰是 templateAllow（去重），deny=[]', () => {
    const out = mergeRules(['Read', 'Bash'], { allow: [], deny: [] });
    expect(out.configured).toBe(true);
    expect(out.allow).toEqual(['Read', 'Bash']);
    expect(out.deny).toEqual([]);
  });

  test('空入参（null + 空全局）→ configured=false, allow=[], deny=[]', () => {
    const out = mergeRules(null, { allow: [], deny: [] });
    expect(out.configured).toBe(false);
    expect(out.allow).toEqual([]);
    expect(out.deny).toEqual([]);
  });

  test('纯函数：不修改入参', () => {
    const tmpl = ['Bash'];
    const global = { allow: ['Read'], deny: ['Kill'] };
    mergeRules(tmpl, global);
    expect(tmpl).toEqual(['Bash']);
    expect(global.allow).toEqual(['Read']);
    expect(global.deny).toEqual(['Kill']);
  });

  test('返回对象独立：改返回值不影响下次调用', () => {
    const global = { allow: ['Read'], deny: [] };
    const a = mergeRules(['Bash'], global);
    a.allow.push('Mutated');
    const b = mergeRules(['Bash'], global);
    expect(b.allow).toEqual(['Bash', 'Read']);
  });
});
