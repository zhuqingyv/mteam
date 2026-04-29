// CanvasNodeExpanded 纯函数单测：展开态 className 计算。
//
// 展开态现在是画布 viewport 内 absolute 定位（和收起态同级），位置由父组件传入，
// 不再有 fixed 锚点计算需要单测。只保留 className 纯函数。

import { describe, test, expect } from 'bun:test';
import { getExpandedClassName } from '../CanvasNodeExpanded';

describe('getExpandedClassName', () => {
  test('默认态：expanded 基础类', () => {
    expect(getExpandedClassName({})).toBe('canvas-node canvas-node--expanded');
  });

  test('dragging=true 追加 --dragging', () => {
    const cn = getExpandedClassName({ dragging: true });
    expect(cn).toContain('canvas-node--expanded');
    expect(cn).toContain('canvas-node--dragging');
  });

  test('dragging=false 不含 --dragging', () => {
    const cn = getExpandedClassName({ dragging: false });
    expect(cn).not.toContain('canvas-node--dragging');
  });
});
