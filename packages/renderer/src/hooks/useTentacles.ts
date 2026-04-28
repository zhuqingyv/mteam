import { useEffect, useRef } from 'react';
import { TentacleRenderer, type BoxGeometry, type TentacleParams } from '../fx/tentacle-renderer';
import type { ActiveEdge } from '../types/chat';

export interface TentacleAgent {
  id: string;
  isLeader: boolean;
}

const LEADER_COLOR: [number, number, number] = [74, 163, 255];
const MEMBER_COLOR: [number, number, number] = [160, 170, 200];
const IDLE_FLOOR = 0.35;

/**
 * Drive a TentacleRenderer from React.
 *
 * - `canvasRef`: the WebGL <canvas>. Must share a positioned ancestor with the
 *   node DOM nodes so their bounding rects are comparable.
 * - `agents`: current set of nodes. Leader + members used for the fallback
 *   (full leader→members) rendering when no `activeEdges` are passed.
 * - `getCardElement(id)`: returns the live DOM node for an agent so we can
 *   read its current position every frame.
 * - `activeEdges` (S6-M2)：传入后只画列出的边；颜色按 intensity 调亮度，暗→亮。
 *    支持静态数组或每帧调用的 getter（intensity 会随时间衰减，所以生产环境推荐 getter）。
 *    不传 → 兼容旧行为，画全量 leader → members。
 */
export function useTentacles(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  agents: TentacleAgent[],
  getCardElement: (id: string) => HTMLElement | null,
  activeEdges?: ActiveEdge[] | (() => ActiveEdge[]),
) {
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const getElRef = useRef(getCardElement);
  getElRef.current = getCardElement;
  const edgesRef = useRef<ActiveEdge[] | (() => ActiveEdge[]) | undefined>(activeEdges);
  edgesRef.current = activeEdges;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: TentacleRenderer;
    try {
      renderer = new TentacleRenderer(canvas);
    } catch (err) {
      console.warn('[useTentacles] WebGL2 unavailable:', err);
      return;
    }

    const resizeObserver = new ResizeObserver(() => renderer.resize());
    resizeObserver.observe(canvas);

    let rafId: number | null = null;
    const tick = () => {
      const parent = canvas.parentElement;
      if (parent) {
        const baseRect = parent.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const edgesIn = edgesRef.current;
        const edges = typeof edgesIn === 'function' ? edgesIn() : edgesIn;
        const list = edges
          ? buildActiveTentacles(edges, getElRef.current, baseRect, dpr)
          : buildLeaderTentacles(agentsRef.current, getElRef.current, baseRect, dpr);
        renderer.setTentacles(list);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    renderer.start();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, [canvasRef]);
}

/** @internal exported for tests */
export function rectToBox(el: HTMLElement, base: DOMRect, dpr: number): BoxGeometry | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    x: (r.left - base.left) * dpr,
    y: (r.top - base.top) * dpr,
    w: r.width * dpr,
    h: r.height * dpr,
  };
}

/** @internal exported for tests */
export function scaleColor(c: [number, number, number], k: number): [number, number, number] {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** @internal exported for tests */
export function buildLeaderTentacles(
  agents: TentacleAgent[],
  getEl: (id: string) => HTMLElement | null,
  base: DOMRect,
  dpr: number,
): TentacleParams[] {
  const leader = agents.find((a) => a.isLeader);
  if (!leader) return [];
  const leaderEl = getEl(leader.id);
  if (!leaderEl) return [];
  const leaderBox = rectToBox(leaderEl, base, dpr);
  if (!leaderBox) return [];

  const out: TentacleParams[] = [];
  for (const a of agents) {
    if (a.isLeader) continue;
    const el = getEl(a.id);
    if (!el) continue;
    const box = rectToBox(el, base, dpr);
    if (!box) continue;
    out.push({
      fromBox: leaderBox,
      toBox: box,
      colorA: LEADER_COLOR,
      colorB: MEMBER_COLOR,
    });
  }
  return out;
}

/** @internal exported for tests */
export function buildActiveTentacles(
  edges: ActiveEdge[],
  getEl: (id: string) => HTMLElement | null,
  base: DOMRect,
  dpr: number,
): TentacleParams[] {
  const out: TentacleParams[] = [];
  for (const e of edges) {
    const fromEl = getEl(e.fromId);
    const toEl = getEl(e.toId);
    if (!fromEl || !toEl) continue;
    const fromBox = rectToBox(fromEl, base, dpr);
    const toBox = rectToBox(toEl, base, dpr);
    if (!fromBox || !toBox) continue;
    const k = IDLE_FLOOR + (1 - IDLE_FLOOR) * Math.max(0, Math.min(1, e.intensity));
    out.push({
      fromBox,
      toBox,
      colorA: scaleColor(LEADER_COLOR, k),
      colorB: scaleColor(MEMBER_COLOR, k),
    });
  }
  return out;
}
