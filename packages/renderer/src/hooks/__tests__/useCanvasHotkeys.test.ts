// useCanvasHotkeys 纯判定单测。
// DOM 事件挂载有副作用，项目统一只测纯函数（对齐 CanvasNode.test.ts / useInstanceSubscriptions.test.ts）。

import { describe, test, expect } from 'bun:test';
import { isEditableTarget, matchHotkey } from '../useCanvasHotkeys';

function fakeTarget(tag: string, contentEditable = false): EventTarget {
  return { tagName: tag, isContentEditable: contentEditable } as unknown as EventTarget;
}

describe('isEditableTarget', () => {
  test('INPUT / TEXTAREA / SELECT → true', () => {
    expect(isEditableTarget(fakeTarget('INPUT'))).toBe(true);
    expect(isEditableTarget(fakeTarget('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(fakeTarget('SELECT'))).toBe(true);
  });

  test('contentEditable → true', () => {
    expect(isEditableTarget(fakeTarget('DIV', true))).toBe(true);
  });

  test('普通元素 → false', () => {
    expect(isEditableTarget(fakeTarget('DIV'))).toBe(false);
    expect(isEditableTarget(fakeTarget('BUTTON'))).toBe(false);
  });

  test('null / 非 HTMLElement → false', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

function fakeKey(key: string, mod: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mod.ctrl,
    metaKey: !!mod.meta,
    altKey: !!mod.alt,
    shiftKey: !!mod.shift,
  } as unknown as KeyboardEvent;
}

describe('matchHotkey', () => {
  test('Esc → escape', () => {
    expect(matchHotkey(fakeKey('Escape'))).toBe('escape');
  });

  test('f / F → fit', () => {
    expect(matchHotkey(fakeKey('f'))).toBe('fit');
    expect(matchHotkey(fakeKey('F'))).toBe('fit');
  });

  test('0 → reset', () => {
    expect(matchHotkey(fakeKey('0'))).toBe('reset');
  });

  test('带修饰键一律放行', () => {
    expect(matchHotkey(fakeKey('Escape', { meta: true }))).toBe(null);
    expect(matchHotkey(fakeKey('f', { ctrl: true }))).toBe(null);
    expect(matchHotkey(fakeKey('0', { alt: true }))).toBe(null);
    expect(matchHotkey(fakeKey('0', { shift: true }))).toBe(null);
  });

  test('其它键 → null', () => {
    expect(matchHotkey(fakeKey('a'))).toBe(null);
    expect(matchHotkey(fakeKey('Enter'))).toBe(null);
    expect(matchHotkey(fakeKey('1'))).toBe(null);
  });
});
