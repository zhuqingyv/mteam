import { useRef, useCallback } from 'react';

const DRAG_THRESHOLD = 5;

export function useCapsuleDrag(onTap: () => void) {
  const stateRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    stateRef.current = { startX: e.screenX, startY: e.screenY, dragging: false };
    window.electronAPI?.startDrag(e.screenX, e.screenY);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    if (!s) return;
    const dx = e.screenX - s.startX;
    const dy = e.screenY - s.startY;
    if (!s.dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      s.dragging = true;
    }
    if (s.dragging) {
      window.electronAPI?.dragMove(e.screenX, e.screenY);
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    stateRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    if (s && !s.dragging) {
      onTap();
    }
  }, [onTap]);

  return { onPointerDown, onPointerMove, onPointerUp };
}
