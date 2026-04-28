// Instance 订阅登记表（module-level）。
//
// 为什么单独拆这一层：
// - useWsEvents 维护一个全局订阅集合，primary agent 是基础订阅；
//   Sprint 3 CanvasNode 展开时要在任意组件里 addInstanceSub(id)，卸载时 remove。
// - 这个集合既要被 useWsEvents 以 React state 形式喂给 useInstanceSubscriptions 做 diff，
//   又要被其它组件直接调 API —— 天然的 module-level 发布订阅结构。
// - 不进 zustand 是因为这是"订阅意图"的纯内存状态，不参与业务 store；也不落盘。

import { useMemo, useSyncExternalStore } from 'react';

type Listener = () => void;

// 登记的"额外" instance id（不含 primary）。primary 由调用方在外层拼接。
const extraIds = new Set<string>();
const listeners = new Set<Listener>();

// 稳定引用快照：extraIds 未变时返回同一个数组，useSyncExternalStore 才会判定无变化。
let cachedExtras: string[] = [];
let cachedVersion = 0;
let snapshotVersion = -1;

function emit(): void {
  cachedVersion += 1;
  for (const l of listeners) l();
}

function getExtrasSnapshot(): string[] {
  if (snapshotVersion !== cachedVersion) {
    cachedExtras = Array.from(extraIds);
    snapshotVersion = cachedVersion;
  }
  return cachedExtras;
}

export function addInstanceSub(id: string): void {
  if (!id) return;
  if (extraIds.has(id)) return;
  extraIds.add(id);
  emit();
}

export function removeInstanceSub(id: string): void {
  if (!id) return;
  if (!extraIds.delete(id)) return;
  emit();
}

// 仅测试用：清空所有登记，避免测试间串污。
export function _resetInstanceSubRegistryForTest(): void {
  extraIds.clear();
  listeners.clear();
  cachedExtras = [];
  cachedVersion = 0;
  snapshotVersion = -1;
}

// 仅测试 / 诊断用：读当前 extra id 集合的快照。
export function _getExtraIdsForTest(): string[] {
  return Array.from(extraIds);
}

// React hook：返回 primary + 所有 extra 合并后的订阅 id 数组。
// primaryId 或 extraIds 任意变化时产生新数组引用；未变时保持引用稳定。
export function useSubscribedInstanceIds(primaryId: string | null): string[] {
  const extras = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getExtrasSnapshot,
    // SSR 兜底：renderer 走不到；给个稳定空数组引用。
    () => EMPTY,
  );
  return useMemo(() => {
    if (!primaryId) return extras;
    // primary 不在 extras 里才拼前面；已经登记过则保持 extras 原样（避免重复订阅 id）。
    if (extras.includes(primaryId)) return extras;
    return [primaryId, ...extras];
  }, [primaryId, extras]);
}

const EMPTY: string[] = [];
