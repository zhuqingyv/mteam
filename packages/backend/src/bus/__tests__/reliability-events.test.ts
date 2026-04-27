// W1-7 · bus 侧 reliability 域 3 条事件契约冻结测试。
//
// 新增事件：
//   runtime.fatal       —— unhandledRejection / uncaughtException 上报
//   memory.warn         —— MemoryManager 集合水位告警
//   process.reaped      —— 孤儿进程清扫（S5 snapshot 对比 pid 文件后）
//
// 守三件事：
//   1) makeBase 能构造这三类事件基础字段（type/ts/source/eventId 完整）。
//   2) 各事件 payload 字段冻结，类型断言保证后续改字段会编译失败。
//   3) BusEvent 总联合包含这三条（用类型守卫走窄化分支验证）。

import { describe, it, expect } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import type {
  BusEvent,
  RuntimeFatalEvent,
  MemoryWarnEvent,
  ProcessReapedEvent,
} from '../types.js';

const SOURCE = 'test:reliability-events';

describe('W1-7 · bus reliability 域事件契约', () => {
  it('runtime.fatal 可 emit + 下游类型收窄', async () => {
    const bus = new EventBus();
    const received: RuntimeFatalEvent[] = [];
    bus.on('runtime.fatal').subscribe((e) => received.push(e));

    const ev: RuntimeFatalEvent = {
      ...makeBase('runtime.fatal', SOURCE),
      kind: 'unhandledRejection',
      message: 'boom',
      stack: 'Error: boom\n  at test',
    };
    bus.emit(ev);

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe('unhandledRejection');
    expect(received[0].message).toBe('boom');
    expect(received[0].stack).toBe('Error: boom\n  at test');
    expect(received[0].eventId).toBeTypeOf('string');
    bus.destroy();
  });

  it('runtime.fatal 的 stack 可省略', () => {
    const ev: RuntimeFatalEvent = {
      ...makeBase('runtime.fatal', SOURCE),
      kind: 'uncaughtException',
      message: 'x',
    };
    expect(ev.stack).toBeUndefined();
  });

  it('memory.warn 携带 collection/size/maxSize/strategy', () => {
    const bus = new EventBus();
    const received: MemoryWarnEvent[] = [];
    bus.on('memory.warn').subscribe((e) => received.push(e));

    const ev: MemoryWarnEvent = {
      ...makeBase('memory.warn', SOURCE),
      collection: 'session-cache',
      size: 900,
      maxSize: 1000,
      strategy: 'lru',
    };
    bus.emit(ev);

    expect(received.length).toBe(1);
    expect(received[0].collection).toBe('session-cache');
    expect(received[0].size).toBe(900);
    expect(received[0].maxSize).toBe(1000);
    expect(received[0].strategy).toBe('lru');
    bus.destroy();
  });

  it('memory.warn strategy 字面量三选一', () => {
    const lru: MemoryWarnEvent['strategy'] = 'lru';
    const ttl: MemoryWarnEvent['strategy'] = 'ttl';
    const fifo: MemoryWarnEvent['strategy'] = 'fifo';
    expect([lru, ttl, fifo].length).toBe(3);
  });

  it('process.reaped 携带 pid/owner/reason', () => {
    const bus = new EventBus();
    const received: ProcessReapedEvent[] = [];
    bus.on('process.reaped').subscribe((e) => received.push(e));

    const ev: ProcessReapedEvent = {
      ...makeBase('process.reaped', SOURCE),
      pid: 12345,
      owner: 'primary-agent',
      reason: 'orphan',
    };
    bus.emit(ev);

    expect(received.length).toBe(1);
    expect(received[0].pid).toBe(12345);
    expect(received[0].owner).toBe('primary-agent');
    expect(received[0].reason).toBe('orphan');
    bus.destroy();
  });

  it('process.reaped 允许 owner=null（老 snapshot）', () => {
    const ev: ProcessReapedEvent = {
      ...makeBase('process.reaped', SOURCE),
      pid: 42,
      owner: null,
      reason: 'stale_temp',
    };
    expect(ev.owner).toBeNull();
    expect(ev.reason).toBe('stale_temp');
  });

  it('BusEvent 总联合覆盖三条事件（类型守卫不 fallthrough default）', () => {
    function handle(e: BusEvent): string {
      switch (e.type) {
        case 'runtime.fatal':
          return `fatal:${e.kind}:${e.message}`;
        case 'memory.warn':
          return `warn:${e.collection}:${e.size}/${e.maxSize}`;
        case 'process.reaped':
          return `reap:${e.pid}:${e.reason}`;
        default:
          return 'other';
      }
    }

    const fatal = handle({
      ...makeBase('runtime.fatal', SOURCE),
      kind: 'uncaughtException',
      message: 'x',
    });
    const warn = handle({
      ...makeBase('memory.warn', SOURCE),
      collection: 'c',
      size: 1,
      maxSize: 10,
      strategy: 'fifo',
    });
    const reap = handle({
      ...makeBase('process.reaped', SOURCE),
      pid: 7,
      owner: 'test',
      reason: 'orphan',
    });

    expect(fatal).toBe('fatal:uncaughtException:x');
    expect(warn).toBe('warn:c:1/10');
    expect(reap).toBe('reap:7:orphan');
  });
});
