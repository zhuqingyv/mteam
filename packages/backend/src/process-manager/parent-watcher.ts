// W1-2 · 父进程心跳（ppid 轮询兜底）
//
// 父进程被 SIGKILL / 崩溃后，子进程 ppid 会被 init/launchd 收养变成 1。
// 轮询 process.ppid，变化即触发一次回调。与 W1-2b stdin EOF 双保险。
// 纯函数：不 import 业务，不 emit bus。intervalMs 写死 500，不暴露。

export interface ParentWatcher {
  stop(): void;
}

export interface ParentWatcherOptions {
  initialPpid?: number;
  /** 读当前 ppid，默认 () => process.ppid。仅测试注入。 */
  readPpid?: () => number;
}

const INTERVAL_MS = 500;

export function watchParentAlive(
  onParentGone: () => void,
  opts: ParentWatcherOptions = {},
): ParentWatcher {
  const readPpid = opts.readPpid ?? (() => process.ppid);
  const initial = opts.initialPpid ?? readPpid();
  let fired = false;
  let stopped = false;

  const timer: NodeJS.Timeout = setInterval(() => {
    if (stopped || fired) return;
    if (readPpid() !== initial) {
      fired = true;
      clearInterval(timer);
      try { onParentGone(); } catch { /* 回调异常不影响监视器 */ }
    }
  }, INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
