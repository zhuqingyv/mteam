// S6-M2 useTentacles 纯函数单测（WebGL / canvas 不在 jsdom 跑，改测拆出的构建函数）。
// 覆盖：
// - buildLeaderTentacles：有 leader → 全量 leader→member；没 leader → 空
// - buildActiveTentacles：按 activeEdges 画、缺节点元素跳过、intensity 调色

import { describe, it, expect } from 'bun:test';
import { buildLeaderTentacles, buildActiveTentacles, scaleColor } from '../useTentacles';
import type { ActiveEdge } from '../../types/chat';

function fakeEl(x: number, y: number, w = 60, h = 60): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }),
  } as unknown as HTMLElement;
}

const BASE = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

describe('scaleColor', () => {
  it('按系数等比缩放 RGB', () => {
    expect(scaleColor([100, 200, 50], 0.5)).toEqual([50, 100, 25]);
  });
});

describe('buildLeaderTentacles (fallback)', () => {
  it('有 leader 时画 leader→每个 member', () => {
    const agents = [
      { id: 'L', isLeader: true },
      { id: 'M1', isLeader: false },
      { id: 'M2', isLeader: false },
    ];
    const els: Record<string, HTMLElement> = {
      L: fakeEl(100, 100),
      M1: fakeEl(300, 100),
      M2: fakeEl(100, 300),
    };
    const out = buildLeaderTentacles(agents, (id) => els[id] ?? null, BASE, 1);
    expect(out.length).toBe(2);
    expect(out[0].fromBox.x).toBe(100);
    expect(out[0].toBox.x).toBe(300);
  });

  it('无 leader 返回空', () => {
    const out = buildLeaderTentacles([{ id: 'M', isLeader: false }], () => null, BASE, 1);
    expect(out).toEqual([]);
  });

  it('leader 找不到 DOM 元素 → 空', () => {
    const out = buildLeaderTentacles([{ id: 'L', isLeader: true }, { id: 'M', isLeader: false }], () => null, BASE, 1);
    expect(out).toEqual([]);
  });
});

describe('buildActiveTentacles (activeEdges 路径)', () => {
  it('空 edges 返回空', () => {
    expect(buildActiveTentacles([], () => fakeEl(0, 0), BASE, 1)).toEqual([]);
  });

  it('按 edges 顺序画；缺节点的边跳过', () => {
    const edges: ActiveEdge[] = [
      { fromId: 'A', toId: 'B', intensity: 1, lastActiveTs: 0 },
      { fromId: 'A', toId: 'X', intensity: 0.5, lastActiveTs: 0 }, // X 无元素
      { fromId: 'C', toId: 'A', intensity: 0.2, lastActiveTs: 0 },
    ];
    const els: Record<string, HTMLElement> = {
      A: fakeEl(10, 10),
      B: fakeEl(200, 10),
      C: fakeEl(10, 200),
    };
    const out = buildActiveTentacles(edges, (id) => els[id] ?? null, BASE, 1);
    expect(out.length).toBe(2);
    expect(out[0].toBox.x).toBe(200);
    expect(out[1].fromBox.x).toBe(10);
    expect(out[1].fromBox.y).toBe(200);
  });

  it('intensity 调色：1.0 原色，0.0 按 floor 降亮', () => {
    const els: Record<string, HTMLElement> = {
      A: fakeEl(10, 10),
      B: fakeEl(200, 10),
    };
    const bright = buildActiveTentacles(
      [{ fromId: 'A', toId: 'B', intensity: 1, lastActiveTs: 0 }],
      (id) => els[id] ?? null, BASE, 1,
    );
    const dim = buildActiveTentacles(
      [{ fromId: 'A', toId: 'B', intensity: 0, lastActiveTs: 0 }],
      (id) => els[id] ?? null, BASE, 1,
    );
    expect(bright[0].colorA[0]).toBeGreaterThan(dim[0].colorA[0]);
    expect(bright[0].colorB[0]).toBeGreaterThan(dim[0].colorB[0]);
    // floor 不为 0（整条边不应该完全灰掉）
    expect(dim[0].colorA[0]).toBeGreaterThan(0);
  });
});
