import { useState, useRef, useEffect } from 'react';
import { useWindowStore, selectExpanded, selectSetExpanded } from '../store';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const ANIM_MS = 350;

const INITIAL_EXPANDED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('expanded') === '1';

export function useCapsuleToggle() {
  const expanded = useWindowStore(selectExpanded);
  const setExpanded = useWindowStore(selectSetExpanded);
  const [animating, setAnimating] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (INITIAL_EXPANDED) setExpanded(true);
  }, [setExpanded]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onDragStart || !api?.onDragEnd) return;
    const offStart = api.onDragStart(() => { draggingRef.current = true; });
    const offEnd = api.onDragEnd(() => { draggingRef.current = false; });
    return () => { offStart(); offEnd(); };
  }, []);

  const schedule = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  };

  const toggle = () => {
    if (draggingRef.current) return;
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    setAnimating(true);
    if (!expanded) {
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
      requestAnimationFrame(() => setExpanded(true));
      schedule(() => setAnimating(false), ANIM_MS);
    } else {
      window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true);
      requestAnimationFrame(() => setExpanded(false));
      schedule(() => setAnimating(false), ANIM_MS);
    }
  };

  return { expanded, animating, toggle };
}
