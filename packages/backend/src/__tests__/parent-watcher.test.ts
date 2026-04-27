// W1-2 parent-watcher 单测
// 契约：ppid 变化回调只触发一次；stop 幂等；不 import 业务路径。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchParentAlive } from '../process-manager/parent-watcher.js';

describe('parent-watcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ppid 不变时不触发回调', () => {
    const cb = vi.fn();
    let ppid = 100;
    const w = watchParentAlive(cb, { initialPpid: ppid, readPpid: () => ppid });
    vi.advanceTimersByTime(2000); // 4 轮
    expect(cb).not.toHaveBeenCalled();
    w.stop();
  });

  it('ppid 变化后回调触发一次', () => {
    const cb = vi.fn();
    let ppid = 100;
    const w = watchParentAlive(cb, { initialPpid: 100, readPpid: () => ppid });
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
    ppid = 1; // 被 init 收养
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('ppid 持续变化回调也只触发一次', () => {
    const cb = vi.fn();
    let ppid = 100;
    const w = watchParentAlive(cb, { initialPpid: 100, readPpid: () => ppid });
    ppid = 1;
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    ppid = 2;
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('stop 幂等', () => {
    const cb = vi.fn();
    const w = watchParentAlive(cb, { initialPpid: 100, readPpid: () => 100 });
    expect(() => { w.stop(); w.stop(); w.stop(); }).not.toThrow();
  });

  it('stop 后 ppid 变化不再触发', () => {
    const cb = vi.fn();
    let ppid = 100;
    const w = watchParentAlive(cb, { initialPpid: 100, readPpid: () => ppid });
    w.stop();
    ppid = 1;
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('回调抛错不影响监视器（触发一次就停）', () => {
    const cb = vi.fn(() => { throw new Error('boom'); });
    let ppid = 100;
    const w = watchParentAlive(cb, { initialPpid: 100, readPpid: () => ppid });
    ppid = 1;
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
    // 后续不再触发
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('默认 initialPpid 读 process.ppid', () => {
    const cb = vi.fn();
    // 不传 initialPpid,应从 readPpid 初读
    let called = 0;
    const w = watchParentAlive(cb, { readPpid: () => { called++; return 42; } });
    expect(called).toBeGreaterThanOrEqual(1); // 初始化至少读一次
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
    w.stop();
  });
});
