// W1-2b · stdin EOF 监听（父死子随主通道）
// 父退出 → stdin pipe 关闭 → 'end'/'close'。内核即时通知。
// 必须 resume(),paused stream 不触发 EOF。与 W1-2 ppid 双保险。

import type { Readable } from 'node:stream';

export interface StdinWatcher { stop(): void; }

export interface StdinWatcherOptions {
  /** 默认 process.stdin。仅测试注入。 */
  stdin?: Readable;
}

export function watchStdinEnd(
  onEof: () => void,
  opts: StdinWatcherOptions = {},
): StdinWatcher {
  const stdin = opts.stdin ?? process.stdin;
  let fired = false;
  let stopped = false;

  const handler = () => {
    if (stopped || fired) return;
    fired = true;
    try { onEof(); } catch { /* 回调异常不影响监视器 */ }
  };

  stdin.on('end', handler);
  stdin.on('close', handler);
  stdin.resume?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stdin.off('end', handler);
      stdin.off('close', handler);
    },
  };
}
