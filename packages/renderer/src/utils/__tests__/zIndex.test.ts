import { describe, test, expect } from 'bun:test';
import { resolveNodeZ, Z } from '../zIndex';

describe('resolveNodeZ', () => {
  test('默认态 = VIEWPORT(2)', () => {
    expect(resolveNodeZ({})).toBe(2);
    expect(resolveNodeZ({ dragging: false, expanded: false, focused: false })).toBe(2);
  });

  test('dragging → 10', () => {
    expect(resolveNodeZ({ dragging: true })).toBe(10);
  });

  test('expanded → 20', () => {
    expect(resolveNodeZ({ expanded: true })).toBe(20);
  });

  test('expanded + focused → 30（最高）', () => {
    expect(resolveNodeZ({ expanded: true, focused: true })).toBe(30);
  });

  test('expanded 优先于 dragging（拖展开态也保持 20+）', () => {
    expect(resolveNodeZ({ dragging: true, expanded: true })).toBe(20);
    expect(resolveNodeZ({ dragging: true, expanded: true, focused: true })).toBe(30);
  });

  test('仅 focused 不 expanded → 默认 VIEWPORT（收起态无聚焦语义）', () => {
    expect(resolveNodeZ({ focused: true })).toBe(2);
  });
});

describe('Z 常量', () => {
  test('CANVAS_FX=1 / TOP_UI=40', () => {
    expect(Z.CANVAS_FX).toBe(1);
    expect(Z.TOP_UI).toBe(40);
  });

  test('顺序：CANVAS_FX < VIEWPORT < DRAGGING < EXPANDED < FOCUSED < TOP_UI', () => {
    expect(Z.CANVAS_FX).toBeLessThan(Z.VIEWPORT);
    expect(Z.VIEWPORT).toBeLessThan(Z.NODE_DRAGGING);
    expect(Z.NODE_DRAGGING).toBeLessThan(Z.NODE_EXPANDED);
    expect(Z.NODE_EXPANDED).toBeLessThan(Z.NODE_EXPANDED_FOCUSED);
    expect(Z.NODE_EXPANDED_FOCUSED).toBeLessThan(Z.TOP_UI);
  });
});
