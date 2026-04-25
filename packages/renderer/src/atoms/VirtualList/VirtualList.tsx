import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './VirtualList.css';

interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getKey: (item: T, index: number) => string;
  itemEstimateHeight?: number;
  overscan?: number;
  onScrollTop?: () => void;
  className?: string;
}

export default function VirtualList<T>({
  items, renderItem, getKey,
  itemEstimateHeight = 80, overscan = 3, onScrollTop, className = '',
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const stick = useRef(true);
  const [vp, setVp] = useState({ top: 0, h: 0 });
  const [, force] = useState(0);
  const offsets = useMemo(() => {
    const a: number[] = [0];
    for (let i = 0; i < items.length; i++)
      a.push(a[i] + (heights.current.get(getKey(items[i], i)) ?? itemEstimateHeight));
    return a;
  }, [items, itemEstimateHeight, getKey]);
  const total = offsets[items.length] ?? 0;
  let s = 0;
  while (s < items.length && offsets[s + 1] < vp.top) s++;
  let e = s;
  while (e < items.length && offsets[e] < vp.top + vp.h) e++;
  s = Math.max(0, s - overscan);
  e = Math.min(items.length, e + overscan);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const u = () => setVp({ top: el.scrollTop, h: el.clientHeight });
    u();
    const ro = new ResizeObserver(u);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, total]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (el.scrollTop < 8 && onScrollTop) onScrollTop();
    setVp({ top: el.scrollTop, h: el.clientHeight });
  };
  const measure = (k: string) => (n: HTMLDivElement | null) => {
    if (!n) return;
    const h = n.getBoundingClientRect().height;
    if (heights.current.get(k) !== h) { heights.current.set(k, h); force((x) => x + 1); }
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className={`virtual-list ${className}`.trim()}>
      <div style={{ paddingTop: offsets[s] ?? 0, paddingBottom: total - (offsets[e] ?? 0) }}>
        {items.slice(s, e).map((item, i) => {
          const k = getKey(item, s + i);
          return <div key={k} ref={measure(k)}>{renderItem(item, s + i)}</div>;
        })}
      </div>
    </div>
  );
}
