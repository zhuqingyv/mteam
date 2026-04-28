// W1-2 · 父进程心跳（ppid 轮询兜底）
//
// 父进程被 SIGKILL / 崩溃后，子进程 ppid 会被 init/launchd 收养变成 1。
// 轮询 process.ppid，变化即触发一次回调。与 W1-2b stdin EOF 双保险。
// 纯函数：不 import 业务，不 emit bus。intervalMs 写死 500，不暴露。
//
// Phase 4 §9：收编到 globalTicker 单定时器。本模块仍保持纯净（不 import bus），
// ticker 通过 opts.ticker 可注入，默认读单例。链式单发 reschedule。

import { globalTicker } from '../ticker/ticker.js';
import type { Ticker } from '../ticker/types.js';

export interface ParentWatcher {
  stop(): void;
}

export interface ParentWatcherOptions {
  initialPpid?: number;
  /** 读当前 ppid，默认 () => process.ppid。仅测试注入。 */
  readPpid?: () => number;
  /** 注入 ticker，默认 globalTicker。仅测试注入。 */
  ticker?: Ticker;
  /** 任务 id，默认固定常量；多实例测试可自定义避免冲突。 */
  taskId?: string;
}

const INTERVAL_MS = 500;
const DEFAULT_TASK_ID = 'parent-watcher-ppid';

export function watchParentAlive(
  onParentGone: () => void,
  opts: ParentWatcherOptions = {},
): ParentWatcher {
  const readPpid = opts.readPpid ?? (() => process.ppid);
  const initial = opts.initialPpid ?? readPpid();
  const ticker = opts.ticker ?? globalTicker;
  const taskId = opts.taskId ?? DEFAULT_TASK_ID;
  let fired = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || fired) return;
    if (readPpid() !== initial) {
      fired = true;
      ticker.cancel(taskId);
      try { onParentGone(); } catch { /* 回调异常不影响监视器 */ }
    }
  };

  ticker.schedule({
    id: taskId,
    fireAt: Date.now() + INTERVAL_MS,
    repeat: INTERVAL_MS,
    callback: tick,
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      ticker.cancel(taskId);
    },
  };
}
