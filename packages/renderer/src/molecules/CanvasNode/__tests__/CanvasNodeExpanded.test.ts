// CanvasNodeExpanded 纯函数单测：fixed 定位锚点计算。
// 组件本身依赖 DOM / React hooks，这里只测可抽出的 computeExpandedAnchor。

import { describe, test, expect } from 'bun:test';
import { computeExpandedAnchor } from '../CanvasNodeExpanded';

const PANEL = { w: 420, h: 540 };
const VIEWPORT = { w: 1280, h: 800 };

function rect(left: number, top: number, width = 160, height = 60) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('computeExpandedAnchor', () => {
  test('默认放在右侧（rect.right + 12）、与节点顶部对齐', () => {
    const r = rect(100, 200);
    const a = computeExpandedAnchor(r, PANEL, VIEWPORT);
    expect(a.left).toBe(r.right + 12);
    expect(a.top).toBe(r.top);
  });

  test('expandedIndex=2 → 右侧和顶部都偏移 48px', () => {
    const r = rect(100, 200);
    const a0 = computeExpandedAnchor(r, PANEL, VIEWPORT, 0);
    const a2 = computeExpandedAnchor(r, PANEL, VIEWPORT, 2);
    expect(a2.left - a0.left).toBe(48);
    expect(a2.top - a0.top).toBe(48);
  });

  test('右侧放不下 → 翻到左侧', () => {
    // 节点贴近右边缘：right=1200，右侧只剩 80px，放不下 420 → 翻左
    const r = rect(1040, 100);
    const a = computeExpandedAnchor(r, PANEL, VIEWPORT);
    expect(a.left).toBe(r.left - PANEL.w - 12);
  });

  test('左右都放不下 → 贴右边缘', () => {
    // 小视窗模拟：左右都挤不下
    const tinyVp = { w: 500, h: 600 };
    const r = rect(200, 100, 120, 40);
    const a = computeExpandedAnchor(r, PANEL, tinyVp);
    // 右侧放不下（320+12+420 > 500-8）；左边 200-420-12 < 8 也放不下
    // 回退：贴右边缘 viewport.w - panel.w - 8 = 72
    expect(a.left).toBe(500 - PANEL.w - 8);
  });

  test('底部越界 → 贴视窗底边', () => {
    const r = rect(100, 700);
    const a = computeExpandedAnchor(r, PANEL, VIEWPORT);
    // top = 700 偏移后 > viewport.h - 8 - 540 = 252 → 贴到 252
    expect(a.top).toBe(VIEWPORT.h - PANEL.h - 8);
  });

  test('顶部越界 → 贴到 top=8', () => {
    const r = rect(100, -20);
    const a = computeExpandedAnchor(r, PANEL, VIEWPORT);
    expect(a.top).toBe(8);
  });
});
