// W2-1 · installFatalHandlers 单测。
// 手动 emit process 级事件，验证：
//   1) unhandledRejection → stderr + emit runtime.fatal + 不 shutdown
//   2) uncaughtException  → stderr + emit runtime.fatal + 触发 shutdown
//   3) bus getter 返回 null（模拟已 destroy）时不抛
//   4) bus.emit 自身抛错不冒泡（M3 防循环）
//   5) uninstall 后再发事件不处理
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { EventBus } from '../../bus/events.js';
import type { RuntimeFatalEvent } from '../../bus/types.js';
import { installFatalHandlers } from '../fatal-handlers.js';

describe('W2-1 installFatalHandlers', () => {
  // 保护：测试用的 listener 在测试结束前卸载，避免污染其他测试。
  let handle: { uninstall: () => void } | null = null;
  const origWrite = process.stderr.write.bind(process.stderr);
  let stderrBuf: string;

  beforeEach(() => {
    stderrBuf = '';
    // bun 的 process.stderr.write 签名兼容 boolean | void；返回 true 即可。
    (process.stderr as unknown as { write: (s: string | Uint8Array) => boolean }).write = (s) => {
      stderrBuf += typeof s === 'string' ? s : Buffer.from(s).toString();
      return true;
    };
  });

  afterEach(() => {
    handle?.uninstall();
    handle = null;
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
  });

  it('unhandledRejection → stderr + emit runtime.fatal + 不 shutdown', () => {
    const bus = new EventBus();
    const got: RuntimeFatalEvent[] = [];
    bus.on('runtime.fatal').subscribe((e) => got.push(e));
    let shutdownCount = 0;

    handle = installFatalHandlers({ getBus: () => bus, shutdown: () => { shutdownCount += 1; } });
    process.emit('unhandledRejection', new Error('boom-rej'), Promise.resolve());

    expect(stderrBuf).toContain('unhandledRejection');
    expect(stderrBuf).toContain('boom-rej');
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe('unhandledRejection');
    expect(got[0].message).toBe('boom-rej');
    expect(got[0].stack).toBeDefined();
    expect(shutdownCount).toBe(0);
    bus.destroy();
  });

  it('uncaughtException → stderr + emit + shutdown 被触发', () => {
    const bus = new EventBus();
    const got: RuntimeFatalEvent[] = [];
    bus.on('runtime.fatal').subscribe((e) => got.push(e));
    let shutdownCount = 0;

    handle = installFatalHandlers({ getBus: () => bus, shutdown: () => { shutdownCount += 1; } });
    process.emit('uncaughtException', new Error('boom-exc'));

    expect(stderrBuf).toContain('uncaughtException');
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe('uncaughtException');
    expect(shutdownCount).toBe(1);
    bus.destroy();
  });

  it('bus getter 返回 null 时不抛（模拟 bus 已 destroy）', () => {
    handle = installFatalHandlers({ getBus: () => null, shutdown: () => {} });
    expect(() => process.emit('unhandledRejection', new Error('x'), Promise.resolve())).not.toThrow();
    expect(stderrBuf).toContain('unhandledRejection');
  });

  it('bus.emit 抛错时被吞掉，不再触发 uncaughtException（防循环）', () => {
    const throwingBus = {
      emit: () => { throw new Error('bus-broken'); },
    } as unknown as EventBus;
    handle = installFatalHandlers({ getBus: () => throwingBus, shutdown: () => {} });
    expect(() => process.emit('uncaughtException', new Error('x'))).not.toThrow();
    expect(stderrBuf).toContain('uncaughtException');
  });

  it('uninstall 后再发事件，handler 不再响应', () => {
    const bus = new EventBus();
    const got: RuntimeFatalEvent[] = [];
    bus.on('runtime.fatal').subscribe((e) => got.push(e));
    const h = installFatalHandlers({ getBus: () => bus, shutdown: () => {} });
    h.uninstall();
    process.emit('unhandledRejection', new Error('x'), Promise.resolve());
    expect(got.length).toBe(0);
    bus.destroy();
  });
});
