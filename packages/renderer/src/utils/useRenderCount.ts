// Phase 4 S6-M4：dev-only 渲染计数探针。
// 用法：`const n = useRenderCount('TeamCanvas');` → 每次渲染 n+1；prod 构建
// `import.meta.env.DEV` 为 false，函数体整块 dead-code，会被 tree-shake。
//
// 纯函数 bumpCount 独立出来便于测试，不依赖 React useRef。

import { useRef } from 'react';

export interface RenderCounter {
  count: number;
  name?: string;
}

/** 纯工具：把 counter.count +1，可选 log，返回新值。 */
export function bumpCount(counter: RenderCounter, log = false, logger: (msg: string) => void = console.debug): number {
  counter.count += 1;
  if (log) logger(`[render] ${counter.name ?? 'anonymous'} #${counter.count}`);
  return counter.count;
}

/**
 * dev 模式下计数调用者的渲染次数。prod 直接返回 0 且不建任何 ref。
 * @param name 仅用于可选 log 前缀
 * @param log  是否在每次渲染打印（默认 false）
 */
export function useRenderCount(name?: string, log = false): number {
  if (!import.meta.env.DEV) return 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const ref = useRef<RenderCounter>({ count: 0, name });
  return bumpCount(ref.current, log);
}
