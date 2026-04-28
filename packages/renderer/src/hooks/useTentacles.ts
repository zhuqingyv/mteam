import { useEffect, useRef } from 'react';
import { TentacleRenderer, type BoxGeometry, type TentacleParams } from '../fx/tentacle-renderer';

export interface TentacleAgent {
  id: string;
  isLeader: boolean;
}

const LEADER_COLOR: [number, number, number] = [74, 163, 255];
const MEMBER_COLOR: [number, number, number] = [160, 170, 200];

/**
 * Drive a TentacleRenderer from React.
 *
 * - `canvasRef`: the WebGL <canvas>. Must share a positioned ancestor with the
 *   AgentCard DOM nodes so their bounding rects are comparable.
 * - `agents`: current set of cards (order not important). Leader → every
 *   non-leader member gets a tentacle.
 * - `getCardElement(id)`: returns the live DOM node for an agent card so we
 *   can read its current position every frame. Positions are not passed in
 *   because AgentCard owns its drag state internally.
 *
 * The renderer is created once per canvas and kept alive for the hook's
 * lifetime; tentacles are re-computed on each animation frame from live DOM.
 */
export function useTentacles(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  agents: TentacleAgent[],
  getCardElement: (id: string) => HTMLElement | null,
) {
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const getElRef = useRef(getCardElement);
  getElRef.current = getCardElement;

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
        const list = buildTentacles(agentsRef.current, getElRef.current, baseRect, dpr);
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

function rectToBox(el: HTMLElement, base: DOMRect, dpr: number): BoxGeometry | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    x: (r.left - base.left) * dpr,
    y: (r.top - base.top) * dpr,
    w: r.width * dpr,
    h: r.height * dpr,
  };
}

function buildTentacles(
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
