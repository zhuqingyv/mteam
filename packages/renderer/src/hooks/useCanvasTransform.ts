import { useCallback, useEffect, useRef, useState } from 'react';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const PAN_DRAG_THRESHOLD = 3;

export interface Transform {
  x: number;
  y: number;
  zoom: number;
}

interface UseCanvasTransformOptions {
  onTransformCommit?: (t: Transform) => void;
}

function applyTransform(el: HTMLElement, t: Transform) {
  el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`;
}

function clampZoom(z: number) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

export function useCanvasTransform(options: UseCanvasTransformOptions = {}) {
  const { onTransformCommit } = options;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<Transform>({ x: 0, y: 0, zoom: 1 });
  const panStateRef = useRef<{ mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const commitRef = useRef(onTransformCommit);
  commitRef.current = onTransformCommit;

  const sync = useCallback(() => {
    const el = viewportRef.current;
    if (el) applyTransform(el, transformRef.current);
  }, []);

  const commit = useCallback(() => {
    commitRef.current?.(transformRef.current);
  }, []);

  const reset = useCallback(() => {
    transformRef.current = { x: 0, y: 0, zoom: 1 };
    sync();
    commit();
  }, [sync, commit]);

  const getTransform = useCallback((): Transform => ({ ...transformRef.current }), []);

  const setTransform = useCallback((t: Transform) => {
    transformRef.current = { x: t.x, y: t.y, zoom: clampZoom(t.zoom) };
    sync();
  }, [sync]);

  const onPanStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (e.target !== e.currentTarget) return;
      const t = transformRef.current;
      panStateRef.current = { mx: e.clientX, my: e.clientY, px: t.x, py: t.y, moved: false };

      const move = (ev: MouseEvent) => {
        const s = panStateRef.current;
        if (!s) return;
        const dx = ev.clientX - s.mx;
        const dy = ev.clientY - s.my;
        if (!s.moved && Math.hypot(dx, dy) > PAN_DRAG_THRESHOLD) {
          s.moved = true;
          setIsPanning(true);
        }
        if (s.moved) {
          transformRef.current = { ...transformRef.current, x: s.px + dx, y: s.py + dy };
          sync();
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const s = panStateRef.current;
        if (s?.moved) {
          setIsPanning(false);
          commit();
        }
        panStateRef.current = null;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [sync, commit],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const t = transformRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = clampZoom(t.zoom * factor);
      if (nextZoom === t.zoom) return;
      const worldX = (cx - t.x) / t.zoom;
      const worldY = (cy - t.y) / t.zoom;
      transformRef.current = {
        zoom: nextZoom,
        x: cx - worldX * nextZoom,
        y: cy - worldY * nextZoom,
      };
      sync();
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => { commit(); commitTimer = null; }, 200);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
      if (commitTimer) clearTimeout(commitTimer);
    };
  }, [sync, commit]);

  const getZoom = useCallback(() => transformRef.current.zoom, []);

  return { viewportRef, containerRef, onPanStart, reset, isPanning, getZoom, getTransform, setTransform };
}
