// CanvasNode 纯逻辑单测。
//
// 组件本身是 React 层薄壳，拖拽判定和 className 计算已抽出为纯函数，
// 项目暂无 DOM 测试栈（对齐 useInstanceSubscriptions 的做法），这里直接测纯函数。

import { describe, test, expect } from 'bun:test';
import {
  DRAG_THRESHOLD,
  exceedsDragThreshold,
  getCanvasNodeClassName,
} from '../CanvasNode';

describe('exceedsDragThreshold', () => {
  test('未超过 3px 阈值返回 false（视为点击）', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(2, 0)).toBe(false);
    expect(exceedsDragThreshold(-2, 1)).toBe(false);
  });

  test('阈值边界：刚好 3px 不触发（> 3 才算拖拽）', () => {
    expect(exceedsDragThreshold(3, 0)).toBe(false);
    expect(exceedsDragThreshold(0, -3)).toBe(false);
  });

  test('超过 3px 视为拖拽', () => {
    expect(exceedsDragThreshold(4, 0)).toBe(true);
    expect(exceedsDragThreshold(-4, 0)).toBe(true);
    expect(exceedsDragThreshold(3, 3)).toBe(true); // 对角 √18 ≈ 4.24
  });

  test('支持自定义阈值', () => {
    expect(exceedsDragThreshold(5, 0, 10)).toBe(false);
    expect(exceedsDragThreshold(11, 0, 10)).toBe(true);
  });

  test('DRAG_THRESHOLD 常量等于 3', () => {
    expect(DRAG_THRESHOLD).toBe(3);
  });
});

describe('getCanvasNodeClassName', () => {
  test('默认态：collapsed 基础类', () => {
    expect(getCanvasNodeClassName({})).toBe('canvas-node canvas-node--collapsed');
  });

  test('dragging=true 追加 --dragging 修饰', () => {
    const cn = getCanvasNodeClassName({ dragging: true });
    expect(cn).toContain('canvas-node--collapsed');
    expect(cn).toContain('canvas-node--dragging');
  });

  test('isLeader=true 追加 --leader 修饰', () => {
    const cn = getCanvasNodeClassName({ isLeader: true });
    expect(cn).toContain('canvas-node--leader');
    expect(cn).not.toContain('canvas-node--dragging');
  });

  test('dragging + leader 同时生效', () => {
    const cn = getCanvasNodeClassName({ dragging: true, isLeader: true });
    expect(cn).toContain('canvas-node--dragging');
    expect(cn).toContain('canvas-node--leader');
  });

  test('关闭 dragging 后 --dragging 消失（props 变化 → class 变化）', () => {
    const on = getCanvasNodeClassName({ dragging: true });
    const off = getCanvasNodeClassName({ dragging: false });
    expect(on).toContain('canvas-node--dragging');
    expect(off).not.toContain('canvas-node--dragging');
  });
});

describe('拖拽 vs 点击语义（AC：onDragEnd 仅在 moved>3px 触发）', () => {
  // 重现 CanvasNode 里的判定：若 move 过程中 exceedsDragThreshold(dx,dy) 为 true，
  // 标 moved；mouseup 时 moved=true → onDragEnd，否则 → onOpen。
  function simulateDragOrClick(dx: number, dy: number): 'drag' | 'click' {
    return exceedsDragThreshold(dx, dy) ? 'drag' : 'click';
  }

  test('位移 2px → click', () => {
    expect(simulateDragOrClick(2, 0)).toBe('click');
  });

  test('位移刚好 3px → click（阈值不含）', () => {
    expect(simulateDragOrClick(3, 0)).toBe('click');
  });

  test('位移 4px → drag', () => {
    expect(simulateDragOrClick(4, 0)).toBe('drag');
  });

  test('抖动式点击 (0.5px) → click', () => {
    expect(simulateDragOrClick(0.5, -0.3)).toBe('click');
  });
});
