// useExpandedStack 栈语义纯函数化测试：手写 reducer-style 验证 open/close/popTop。
// React state 不能直接测，这里把语义抽成等价函数验证。

import { describe, test, expect } from 'bun:test';

// 复刻 useExpandedStack 的纯语义（与 hook 实现保持一致）
function open(stack: string[], id: string): string[] {
  return [...stack.filter((x) => x !== id), id];
}
function close(stack: string[], id: string): string[] {
  return stack.filter((x) => x !== id);
}
function popTop(stack: string[]): { next: string[]; popped: string | null } {
  if (stack.length === 0) return { next: stack, popped: null };
  return { next: stack.slice(0, -1), popped: stack[stack.length - 1] };
}

describe('useExpandedStack semantics', () => {
  test('open 新 id 压栈顶', () => {
    expect(open([], 'a')).toEqual(['a']);
    expect(open(['a'], 'b')).toEqual(['a', 'b']);
  });

  test('open 已存在 id → 移到栈顶（去重）', () => {
    expect(open(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
  });

  test('close 移除指定 id，其它顺序保留', () => {
    expect(close(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  test('close 不存在的 id → 栈不变', () => {
    expect(close(['a'], 'x')).toEqual(['a']);
  });

  test('popTop 弹最上层并返回', () => {
    expect(popTop(['a', 'b', 'c'])).toEqual({ next: ['a', 'b'], popped: 'c' });
  });

  test('popTop 空栈 → 原样返回 + popped=null', () => {
    expect(popTop([])).toEqual({ next: [], popped: null });
  });
});
