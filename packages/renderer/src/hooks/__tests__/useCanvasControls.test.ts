// S4-M4 useCanvasControls 单测：纯函数 computeFitTransform 为主。
//
// 覆盖：
// - 空节点 → zoom=1 pan=0
// - 单节点 / 多节点包围盒 → 中心落在 viewport 中心
// - 节点比 viewport 大 → zoom 被 clamp 到 min (0.25)
// - 节点比 viewport 小很多 → zoom 被 clamp 到 max (3)
// - 横纵比不一致 → 取 min(w 比, h 比)，保证整个包围盒都塞得下
// - padding 计算：viewport 可用区减去 padding*2
//
// wrapper hook 只是 useCallback 薄壳；组合+ clamp 逻辑已由 computeFitTransform 覆盖。

import { describe, test, expect } from 'bun:test';
import { computeFitTransform, type BBox } from '../useCanvasControls';

function bbox(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}

describe('computeFitTransform 边界', () => {
  test('空节点 → 原点 zoom=1', () => {
    expect(computeFitTransform([], { w: 800, h: 600 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  test('包围盒宽高为 0 → 回退 zoom=1 pan=0', () => {
    const t = computeFitTransform([bbox(10, 10, 0, 0)], { w: 800, h: 600 });
    expect(t).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe('computeFitTransform 居中', () => {
  test('单节点塞得下 → zoom 被 clamp 到 3，包围盒中心落 viewport 中心', () => {
    // 节点 100x100，居中在 (50, 50)；viewport 800x600，padding 40
    // 可用区 720x520，最大缩放 min(720/100, 520/100)=5.2，被 clamp 到 3
    const t = computeFitTransform([bbox(0, 0, 100, 100)], { w: 800, h: 600 }, 40);
    expect(t.zoom).toBe(3);
    // 节点中心 (50, 50) → 屏幕中心 (400, 300)：pan = 400 - 50*3 = 250; 300 - 150 = 150
    expect(t.x).toBe(250);
    expect(t.y).toBe(150);
  });

  test('多节点包围盒 → 中心 = (minX+maxX)/2 映射到 viewport 中心', () => {
    // 两节点：(0,0)-(100,100) 和 (200,200)-(300,300) → 包围盒 (0,0,300,300)，中心 (150,150)
    const t = computeFitTransform(
      [bbox(0, 0, 100, 100), bbox(200, 200, 100, 100)],
      { w: 800, h: 600 },
      40,
    );
    // 可用区 720x520，zoom = min(720/300, 520/300)=520/300≈1.733
    expect(t.zoom).toBeCloseTo(520 / 300, 5);
    // pan.x = 400 - 150 * zoom
    expect(t.x).toBeCloseTo(400 - 150 * (520 / 300), 3);
    expect(t.y).toBeCloseTo(300 - 150 * (520 / 300), 3);
  });

  test('节点比 viewport 大 → zoom clamp 到 min 0.25', () => {
    // 包围盒 10000x10000，viewport 800x600 → 理论 zoom ≈ 0.072，clamp 到 0.25
    const t = computeFitTransform([bbox(0, 0, 10000, 10000)], { w: 800, h: 600 }, 40);
    expect(t.zoom).toBe(0.25);
  });

  test('横纵比不同 → 取较小的缩放比', () => {
    // 超宽节点 1000x50；viewport 800x600；padding 40 → 可用 720x520
    // zx=720/1000=0.72  zy=520/50=10.4 → 取 0.72
    const t = computeFitTransform([bbox(0, 0, 1000, 50)], { w: 800, h: 600 }, 40);
    expect(t.zoom).toBeCloseTo(0.72, 5);
  });
});

