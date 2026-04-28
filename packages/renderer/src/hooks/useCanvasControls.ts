// S4-M4 useCanvasControls：把 useCanvasTransform 的 getTransform/setTransform
// 包装成 CanvasTopBar / ZoomControl 易用的 zoom 操作 API。
//
// 契约：INTERFACE-CONTRACTS §6.4。
// - setZoom(z) = setTransform({ ...getTransform(), zoom: z })，不改 transform hook
// - resetZoom() = 置 zoom=1，保留现有 pan
// - fitAll(nodes) = 算节点包围盒 → 与 viewport 的缩放比 → 居中 pan
// - zoom / zoomPercent 为 snapshot 值，来源 getTransform()，useMemo 依赖外层触发 re-render
//
// 纯函数 computeFitTransform 抽出，便于 bun:test 免 DOM 验证 fitAll 计算。

import { useCallback, useMemo } from 'react';
import type { Transform } from './useCanvasTransform';

export interface TransformApi {
  getTransform: () => Transform;
  setTransform: (t: Transform) => void;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasControls {
  zoom: number;
  zoomPercent: number;
  setZoom: (z: number) => void;
  resetZoom: () => void;
  fitAll: (nodes: BBox[], viewport?: { w: number; h: number }) => void;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const FIT_PADDING = 40;
const DEFAULT_VIEWPORT = { w: 960, h: 560 };

function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

// 从节点 bbox 列表算包围盒。空列表返回 null。
function unionBBox(nodes: BBox[]): BBox | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 纯函数：给定节点集合 + viewport，算出"适应画布"后的 Transform。
// 空列表 → 回到 zoom=1 pan=0。
export function computeFitTransform(
  nodes: BBox[],
  viewport: { w: number; h: number },
  padding: number = FIT_PADDING,
): Transform {
  const box = unionBBox(nodes);
  if (!box || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, zoom: 1 };
  const availW = Math.max(1, viewport.w - padding * 2);
  const availH = Math.max(1, viewport.h - padding * 2);
  const zoom = clampZoom(Math.min(availW / box.w, availH / box.h));
  // 让包围盒中心落在 viewport 中心：screen = world * zoom + pan
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    zoom,
    x: viewport.w / 2 - cx * zoom,
    y: viewport.h / 2 - cy * zoom,
  };
}

export function useCanvasControls(api: TransformApi): CanvasControls {
  const zoom = api.getTransform().zoom;

  const setZoom = useCallback(
    (z: number) => {
      const cur = api.getTransform();
      api.setTransform({ ...cur, zoom: clampZoom(z) });
    },
    [api],
  );

  const resetZoom = useCallback(() => {
    const cur = api.getTransform();
    api.setTransform({ ...cur, zoom: 1 });
  }, [api]);

  const fitAll = useCallback(
    (nodes: BBox[], viewport: { w: number; h: number } = DEFAULT_VIEWPORT) => {
      api.setTransform(computeFitTransform(nodes, viewport));
    },
    [api],
  );

  const zoomPercent = useMemo(() => Math.round(zoom * 100), [zoom]);

  return { zoom, zoomPercent, setZoom, resetZoom, fitAll };
}
