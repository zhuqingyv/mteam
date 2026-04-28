import { describe, test, expect } from 'bun:test';
import { clampNodePosition } from '../canvasClamp';

const CANVAS = { width: 960, height: 560 };
const NODE = { width: 200, height: 80 };

describe('clampNodePosition', () => {
  test('正中位置：不动、clampedDir=null', () => {
    const r = clampNodePosition({ x: 400, y: 200 }, NODE, CANVAS);
    expect(r.x).toBe(400);
    expect(r.y).toBe(200);
    expect(r.clampedDir).toBe(null);
  });

  test('北边越界 y<padding → 夹到 y=padding，dir=n', () => {
    const r = clampNodePosition({ x: 400, y: -20 }, NODE, CANVAS);
    expect(r.y).toBe(40);
    expect(r.clampedDir).toBe('n');
  });

  test('南边越界 y 超出 → 夹到最大值，dir=s', () => {
    const r = clampNodePosition({ x: 400, y: 9999 }, NODE, CANVAS);
    expect(r.y).toBe(CANVAS.height - NODE.height - 40);
    expect(r.clampedDir).toBe('s');
  });

  test('东边越界 x 超出 → 夹到最大值，dir=e', () => {
    const r = clampNodePosition({ x: 9999, y: 200 }, NODE, CANVAS);
    expect(r.x).toBe(CANVAS.width - NODE.width - 40);
    expect(r.clampedDir).toBe('e');
  });

  test('西边越界 x<padding → 夹到 x=padding，dir=w', () => {
    const r = clampNodePosition({ x: -100, y: 200 }, NODE, CANVAS);
    expect(r.x).toBe(40);
    expect(r.clampedDir).toBe('w');
  });

  test('对角越界：y 方向优先（n/s）', () => {
    const r = clampNodePosition({ x: -100, y: -100 }, NODE, CANVAS);
    expect(r.x).toBe(40);
    expect(r.y).toBe(40);
    expect(r.clampedDir).toBe('n');
  });

  test('自定义 padding 生效', () => {
    const r = clampNodePosition({ x: 0, y: 0 }, NODE, CANVAS, 20);
    expect(r.x).toBe(20);
    expect(r.y).toBe(20);
  });

  test('边界正好等于 padding 不算越界', () => {
    const r = clampNodePosition({ x: 40, y: 40 }, NODE, CANVAS);
    expect(r.clampedDir).toBe(null);
  });

  test('画布过小：居中对齐、dir=null', () => {
    const r = clampNodePosition({ x: 0, y: 0 }, { width: 300, height: 200 }, { width: 200, height: 100 });
    expect(r.clampedDir).toBe(null);
    // node > canvas 时 center 可能为负，取 0
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});
