// S3-G2 useInstancePanel：单个 InstanceChatPanel 挂载时登记 WS instance 订阅并拉一次
// 热快照，卸载时释放订阅。多个 Panel 同时挂同一个 instanceId 时只拉一次 get_turns。
//
// 为什么用 mount-count：展开/收起 CanvasNode 会频繁 mount/unmount Panel 容器；
// 若同一 instanceId 的第一个 consumer 卸载就 remove，后续 consumer 再挂又会重订；
// 引用计数可以让并发挂载共享一次订阅，最后一个 unmount 才真正 remove。
//
// get_turns 的响应 handler（useWsEvents.onTurnsResponse）会按 pendingRequests 里的
// driverId 写入对应桶；本 hook 发的是原始 op（走 client.send），无 requestId 注册，
// 响应会 fallback 到 primary 桶——属于 useWsEvents 层的问题，后续 S3-M1 turnHydrator
// 修。本层只管"登记 + 请求发出"这件事。
//
// 契约：INTERFACE-CONTRACTS §6.2；任务：TASK-LIST S3-G2。

import { useEffect } from 'react';
import { addInstanceSub, removeInstanceSub } from './instanceSubRegistry';
import { useWsStore } from '../store/wsStore';
import type { WsClient } from '../api/ws-protocol';

// instanceId → 当前挂载数。计数 1→2 不再触发 get_turns；N→0 时 remove 订阅。
const mountCount = new Map<string, number>();
// 已经拉过 get_turns 的 instanceId：第一个 mount 触发，后续 mount 不重复拉。
// 全部卸载（计数归 0）后清除，允许下次重新挂载时再拉一次。
const hydrated = new Set<string>();

export interface InstancePanelDeps {
  addSub: (id: string) => void;
  removeSub: (id: string) => void;
  getClient: () => WsClient | null;
}

// 纯逻辑：mount 时登记 + 首次挂拉 get_turns；返回对应 unmount 清理函数。
// 抽出来便于在 bun:test 里不跑 React runtime 直接验证计数和拉取行为。
export function setupInstancePanel(
  instanceId: string,
  deps: InstancePanelDeps,
): () => void {
  if (!instanceId) return () => {};
  const prev = mountCount.get(instanceId) ?? 0;
  mountCount.set(instanceId, prev + 1);
  if (prev === 0) {
    // 第一个 consumer：正式订阅 + 拉一次热快照。
    deps.addSub(instanceId);
    if (!hydrated.has(instanceId)) {
      hydrated.add(instanceId);
      const client = deps.getClient();
      client?.send({ op: 'get_turns', driverId: instanceId, limit: 20 });
    }
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const cur = mountCount.get(instanceId) ?? 0;
    if (cur <= 1) {
      mountCount.delete(instanceId);
      hydrated.delete(instanceId);
      deps.removeSub(instanceId);
    } else {
      mountCount.set(instanceId, cur - 1);
    }
  };
}

// 仅测试用：重置 module-level 状态，避免跨用例串污。
export function _resetInstancePanelForTest(): void {
  mountCount.clear();
  hydrated.clear();
}

export function _getMountCountForTest(instanceId: string): number {
  return mountCount.get(instanceId) ?? 0;
}

export function _isHydratedForTest(instanceId: string): boolean {
  return hydrated.has(instanceId);
}

// React hook 薄壳：useEffect 套 setupInstancePanel。
// deps 只依赖 instanceId —— addInstanceSub / removeInstanceSub / useWsStore 都是稳定引用。
export function useInstancePanel(instanceId: string): void {
  useEffect(() => {
    if (!instanceId) return;
    const dispose = setupInstancePanel(instanceId, {
      addSub: addInstanceSub,
      removeSub: removeInstanceSub,
      getClient: () => useWsStore.getState().client,
    });
    return dispose;
  }, [instanceId]);
}
