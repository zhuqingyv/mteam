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

  useEffect(() => {
    if (INITIAL_EXPANDED) setExpanded(true);
  }, [setExpanded]);

  const schedule = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  };

  const toggle = () => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    setAnimating(true);
    if (!expanded) {
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
      requestAnimationFrame(() => setExpanded(true));
      schedule(() => setAnimating(false), ANIM_MS);
    } else {
      setExpanded(false);
      schedule(() => window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true), ANIM_MS);
      schedule(() => setAnimating(false), ANIM_MS * 2);
    }
  };

  return { expanded, animating, toggle };
}
