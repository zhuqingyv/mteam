// 声明式 WS instance scope 订阅管理。
//
// 职责：
// - 输入 instanceIds 数组变化时 diff：新增 subscribe('instance', id)，消失 unsubscribe('instance', id)
// - 变化频繁时 120ms debounce 合并（防止 props 震荡导致来回 sub/unsub）
// - unmount 自动 unsubscribe 全部（即便处于 debounce 等待态）
// - client 为 null 时 no-op

import { useEffect, useRef } from 'react';
import type { WsClient } from '../api/ws-protocol';

export const SUBSCRIPTION_DEBOUNCE_MS = 120;

// 纯函数 diff：返回新增集合、删除集合、归一化后的下一个 Set。
// 重复 id 自动去重（同一个 id 只会出现一次）。
export function diffSubscriptions(
  prev: ReadonlySet<string>,
  next: Iterable<string>,
): { toAdd: string[]; toRemove: string[]; nextSet: Set<string> } {
  const nextSet = new Set<string>();
  for (const id of next) {
    if (id) nextSet.add(id);
  }
  const toAdd: string[] = [];
  for (const id of nextSet) {
    if (!prev.has(id)) toAdd.push(id);
  }
  const toRemove: string[] = [];
  for (const id of prev) {
    if (!nextSet.has(id)) toRemove.push(id);
  }
  return { toAdd, toRemove, nextSet };
}

// 订阅追踪器：hook 和测试共用的核心逻辑容器。
//
// 和 hook 解耦的理由：hook 的 React 副作用不好在 bun test 里直接跑，
// 把 diff + timer + client 调用都放到这里，测试用 fake timer/client 直接驱动它。
export class SubscriptionTracker {
  private current: Set<string> = new Set();
  private pending: string[] | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly client: WsClient | null,
    private readonly debounceMs: number = SUBSCRIPTION_DEBOUNCE_MS,
    // 可注入定时器，方便单测用 fake clock；默认用原生 setTimeout / clearTimeout。
    private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout> = (cb, ms) => setTimeout(cb, ms),
    private readonly cancel: (id: ReturnType<typeof setTimeout>) => void = (id) => clearTimeout(id),
  ) {}

  // 请求最终状态为 next。hook 每次 useEffect 调一次。
  update(next: readonly string[]): void {
    if (this.disposed) return;
    if (!this.client) return;
    this.pending = [...next];
    if (this.timerId !== null) this.cancel(this.timerId);
    this.timerId = this.schedule(() => {
      this.timerId = null;
      this.flush();
    }, this.debounceMs);
  }

  // 立刻执行一次 diff 并发 WS 命令。仅内部/测试使用。
  flush(): void {
    if (this.disposed || !this.client || this.pending === null) return;
    const { toAdd, toRemove, nextSet } = diffSubscriptions(this.current, this.pending);
    this.pending = null;
    for (const id of toRemove) this.client.unsubscribe('instance', id);
    for (const id of toAdd) this.client.subscribe('instance', id);
    this.current = nextSet;
  }

  // 卸载：清 timer，unsubscribe 已生效的全部 id；pending 未 flush 的新增不订阅（本来也没订上）。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timerId !== null) {
      this.cancel(this.timerId);
      this.timerId = null;
    }
    this.pending = null;
    if (this.client) {
      for (const id of this.current) this.client.unsubscribe('instance', id);
    }
    this.current.clear();
  }

  // 仅测试用：窥视当前已订阅集合。
  _currentForTest(): ReadonlySet<string> {
    return this.current;
  }
  _hasPendingTimer(): boolean {
    return this.timerId !== null;
  }
}

export function useInstanceSubscriptions(
  instanceIds: string[],
  client: WsClient | null,
): void {
  // tracker 绑定 client：client 引用变化（重建）时重建 tracker，老 tracker 卸干净。
  const trackerRef = useRef<SubscriptionTracker | null>(null);

  useEffect(() => {
    if (!client) {
      // client 为 null：no-op，不建 tracker；之前若有 tracker（client 从有变无），销毁。
      trackerRef.current?.dispose();
      trackerRef.current = null;
      return;
    }
    const tracker = new SubscriptionTracker(client);
    trackerRef.current = tracker;
    return () => {
      tracker.dispose();
      if (trackerRef.current === tracker) trackerRef.current = null;
    };
  }, [client]);

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    tracker.update(instanceIds);
    // 不在此处返回 cleanup —— ids 变化时无需立刻 unsubscribe，
    // 下一次 update 的 diff 会计算出 toRemove；真正的卸载交给上面的 client effect。
  }, [instanceIds, client]);
}
