// TeamSidebar 纯逻辑单测：受控 / className / unread 文案。
// DOM 渲染层面靠 playground 手测；这里只覆盖能抽出来的纯函数决策。

import { describe, test, expect } from 'bun:test';
import {
  resolveCollapsed,
  getSidebarClassName,
  formatUnread,
} from '../TeamSidebar';

describe('resolveCollapsed', () => {
  test('controlled=true 覆盖 inner', () => {
    expect(resolveCollapsed(true, false)).toBe(true);
    expect(resolveCollapsed(true, true)).toBe(true);
  });

  test('controlled=false 覆盖 inner', () => {
    expect(resolveCollapsed(false, true)).toBe(false);
    expect(resolveCollapsed(false, false)).toBe(false);
  });

  test('controlled=undefined 使用 inner（向后兼容）', () => {
    expect(resolveCollapsed(undefined, true)).toBe(true);
    expect(resolveCollapsed(undefined, false)).toBe(false);
  });
});

describe('getSidebarClassName', () => {
  test('展开态：基础类', () => {
    expect(getSidebarClassName(false)).toBe('tsb');
  });

  test('收起态：追加 --collapsed', () => {
    expect(getSidebarClassName(true)).toBe('tsb tsb--collapsed');
  });
});

describe('formatUnread', () => {
  test('0 / undefined / 负数 → null（不显示）', () => {
    expect(formatUnread(0)).toBe(null);
    expect(formatUnread(undefined)).toBe(null);
    expect(formatUnread(-3)).toBe(null);
  });

  test('1~99 原样显示', () => {
    expect(formatUnread(1)).toBe('1');
    expect(formatUnread(42)).toBe('42');
    expect(formatUnread(99)).toBe('99');
  });

  test('>99 显示 99+', () => {
    expect(formatUnread(100)).toBe('99+');
    expect(formatUnread(1200)).toBe('99+');
  });
});
