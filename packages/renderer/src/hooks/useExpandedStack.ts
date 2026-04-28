import { useCallback, useRef, useState } from 'react';

// 维护"展开节点 id 栈"：最近打开的在栈顶。
// S5-G3 Esc 关最上层；重复 open 同一个 id 会把它推到栈顶。

export function useExpandedStack() {
  const [stack, setStack] = useState<string[]>([]);
  const nodeElsRef = useRef<Map<string, HTMLElement>>(new Map());
  // anchorTick: 节点元素出现 / 消失时 bump，让依赖 anchorEl 的观察者重新对位
  const [anchorTick, setAnchorTick] = useState(0);

  const open = useCallback((id: string) => {
    setStack((s) => [...s.filter((x) => x !== id), id]);
  }, []);

  const close = useCallback((id: string) => {
    setStack((s) => s.filter((x) => x !== id));
  }, []);

  const popTop = useCallback((): string | null => {
    let popped: string | null = null;
    setStack((s) => {
      if (s.length === 0) return s;
      popped = s[s.length - 1] ?? null;
      return s.slice(0, -1);
    });
    return popped;
  }, []);

  const registerNodeEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodeElsRef.current.set(id, el);
    else nodeElsRef.current.delete(id);
    setAnchorTick((n) => n + 1);
  }, []);

  const getNodeEl = useCallback((id: string) => nodeElsRef.current.get(id) ?? null, []);

  return { stack, open, close, popTop, registerNodeEl, getNodeEl, anchorTick };
}
