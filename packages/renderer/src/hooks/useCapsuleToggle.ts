import { useState, useRef, useEffect } from 'react';
import { useWindowStore, selectExpanded, selectSetExpanded } from '../store';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const RESIZE_MS = 350;
const BODY_FADE_MS = 200;

const INITIAL_EXPANDED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('expanded') === '1';

export function useCapsuleToggle() {
  const expanded = useWindowStore(selectExpanded);
  const setExpanded = useWindowStore(selectSetExpanded);
  const [animating, setAnimating] = useState(false);
  const [bodyVisible, setBodyVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const draggingRef = useRef(false);
  const lockedRef = useRef(false);

  useEffect(() => {
    const initiallyExpanded = INITIAL_EXPANDED || useWindowStore.getState().expanded;
    if (initiallyExpanded) {
      setExpanded(true);
      setBodyVisible(true);
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', false);
    } else {
      window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', false);
    }
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
    if (lockedRef.current) return;
    lockedRef.current = true;
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    if (!expanded) {
      // 展开：先 resize + 切到 expanded 形态，动画跑完再让 body 淡入
      setAnimating(true);
      setExpanded(true);
      setBodyVisible(false);
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
      schedule(() => setBodyVisible(true), RESIZE_MS);
      schedule(() => {
        setAnimating(false);
        lockedRef.current = false;
      }, RESIZE_MS + BODY_FADE_MS);
    } else {
      // 收起：先淡出 body，再 resize，最后才切回胶囊形态
      setAnimating(true);
      setBodyVisible(false);
      schedule(() => {
        window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true);
        setExpanded(false);
      }, BODY_FADE_MS);
      schedule(() => {
        setAnimating(false);
        lockedRef.current = false;
      }, BODY_FADE_MS + RESIZE_MS);
    }
  };

  return { expanded, animating, bodyVisible, toggle };
}
