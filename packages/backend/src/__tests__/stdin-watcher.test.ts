// W1-2b stdin-watcher 单测
// 契约：'end'/'close' 触发回调（只一次）；stop 后不再触发；resume 被调。

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchStdinEnd } from '../process-manager/stdin-watcher.js';

// 构造一个最小 stdin 桩：EventEmitter + resume 桩。
function fakeStdin() {
  const ee = new EventEmitter() as EventEmitter & { resume: () => void; off: typeof EventEmitter.prototype.removeListener };
  ee.resume = vi.fn();
  // EventEmitter 本身就有 off，类型 cast 即可
  return ee as any;
}

describe('stdin-watcher', () => {
  it('end 事件触发回调一次', () => {
    const stdin = fakeStdin();
    const cb = vi.fn();
    const w = watchStdinEnd(cb, { stdin });
    stdin.emit('end');
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('close 事件也触发回调', () => {
    const stdin = fakeStdin();
    const cb = vi.fn();
    const w = watchStdinEnd(cb, { stdin });
    stdin.emit('close');
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('end + close 都派发时回调只跑一次（去重）', () => {
    const stdin = fakeStdin();
    const cb = vi.fn();
    const w = watchStdinEnd(cb, { stdin });
    stdin.emit('end');
    stdin.emit('close');
    stdin.emit('end');
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('resume 被调用（否则 EOF 不触发）', () => {
    const stdin = fakeStdin();
    const cb = vi.fn();
    const w = watchStdinEnd(cb, { stdin });
    expect(stdin.resume).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('stop 后触发 end/close 不再回调', () => {
    const stdin = fakeStdin();
    const cb = vi.fn();
    const w = watchStdinEnd(cb, { stdin });
    w.stop();
    stdin.emit('end');
    stdin.emit('close');
    expect(cb).not.toHaveBeenCalled();
  });

  it('stop 幂等', () => {
    const stdin = fakeStdin();
    const w = watchStdinEnd(() => {}, { stdin });
    expect(() => { w.stop(); w.stop(); w.stop(); }).not.toThrow();
  });

  it('回调抛错不影响监视器，且仍去重', () => {
    const stdin = fakeStdin();
    const cb = vi.fn(() => { throw new Error('boom'); });
    const w = watchStdinEnd(cb, { stdin });
    expect(() => stdin.emit('end')).not.toThrow();
    stdin.emit('end');
    expect(cb).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('默认使用 process.stdin（不传 opts 也不抛）', () => {
    const w = watchStdinEnd(() => {});
    expect(typeof w.stop).toBe('function');
    w.stop();
  });
});
