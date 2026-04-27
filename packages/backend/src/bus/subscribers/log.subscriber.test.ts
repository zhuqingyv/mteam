// P0-1 log.subscriber 单测。
// 真 EventBus + 真 emit；process.stderr.write 临时替换成 capture，用完复位。
// 覆盖：默认静默 / 开关启用普通事件 / 高频黑名单（4 类）被过滤 / ALWAYS_LOG（driver.error + runtime.fatal）
// 不吃开关；黑名单里列的事件在开关打开下也不输出。
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { subscribeLog } from './log.subscriber.js';
import type {
  BusEvent,
  DriverErrorEvent,
  DriverTextEvent,
  DriverThinkingEvent,
  DriverToolUpdateEvent,
  InstanceActivatedEvent,
  RuntimeFatalEvent,
  TurnBlockUpdatedEvent,
} from '../types.js';

const SRC = 'test';

function captureStderr(): { get: () => string; restore: () => void } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  return {
    get: () => buf,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

function mkInstanceActivated(): InstanceActivatedEvent {
  return {
    ...makeBase('instance.activated', SRC),
    instanceId: 'inst_1',
    actor: null,
  };
}
function mkDriverText(): DriverTextEvent {
  return { ...makeBase('driver.text', SRC), driverId: 'd1', content: 'hi' };
}
function mkDriverThinking(): DriverThinkingEvent {
  return { ...makeBase('driver.thinking', SRC), driverId: 'd1', content: '…' };
}
function mkTurnBlockUpdated(): TurnBlockUpdatedEvent {
  return {
    ...makeBase('turn.block_updated', SRC),
    driverId: 'd1',
    turnId: 't1',
    seq: 0,
    block: { type: 'text', blockId: 'b1', seq: 0, content: 'x' } as never,
  };
}
function mkDriverToolUpdate(): DriverToolUpdateEvent {
  return {
    ...makeBase('driver.tool_update', SRC),
    driverId: 'd1',
    toolCallId: 'tc1',
  };
}
function mkDriverError(): DriverErrorEvent {
  return { ...makeBase('driver.error', SRC), driverId: 'd1', message: 'boom' };
}
function mkRuntimeFatal(): RuntimeFatalEvent {
  return {
    ...makeBase('runtime.fatal', SRC),
    kind: 'uncaughtException',
    message: 'crashed',
  };
}

function emitAll(bus: EventBus, events: BusEvent[]): void {
  for (const e of events) bus.emit(e);
}

describe('log.subscriber —— 开关 + 高频黑名单', () => {
  const orig = process.env.TEAM_HUB_LOG_BUS;
  afterEach(() => {
    if (orig === undefined) delete process.env.TEAM_HUB_LOG_BUS;
    else process.env.TEAM_HUB_LOG_BUS = orig;
  });

  it('默认（未设 env） → 非强制事件全部静默', () => {
    delete process.env.TEAM_HUB_LOG_BUS;
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      emitAll(bus, [mkInstanceActivated(), mkDriverText()]);
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toBe('');
  });

  it('TEAM_HUB_LOG_BUS=1 → 输出非黑名单事件', () => {
    process.env.TEAM_HUB_LOG_BUS = '1';
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      bus.emit(mkInstanceActivated());
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toContain('[bus] instance.activated');
  });

  it('TEAM_HUB_LOG_BUS=1 + 4 类高频事件 → 全部不输出', () => {
    process.env.TEAM_HUB_LOG_BUS = '1';
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      emitAll(bus, [
        mkDriverText(),
        mkDriverThinking(),
        mkTurnBlockUpdated(),
        mkDriverToolUpdate(),
      ]);
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toBe('');
  });

  it('driver.error 始终输出（env 未设）', () => {
    delete process.env.TEAM_HUB_LOG_BUS;
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      bus.emit(mkDriverError());
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toContain('[bus] driver.error');
    expect(cap.get()).toContain('boom');
  });

  it('runtime.fatal 始终输出（env 未设）', () => {
    delete process.env.TEAM_HUB_LOG_BUS;
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      bus.emit(mkRuntimeFatal());
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toContain('[bus] runtime.fatal');
    expect(cap.get()).toContain('crashed');
  });

  it('driver.error 在 env=0 下也输出（ALWAYS_LOG 不吃开关）', () => {
    process.env.TEAM_HUB_LOG_BUS = '0';
    const bus = new EventBus();
    const cap = captureStderr();
    try {
      const sub = subscribeLog(bus);
      bus.emit(mkDriverError());
      sub.unsubscribe();
    } finally {
      cap.restore();
    }
    expect(cap.get()).toContain('[bus] driver.error');
  });
});
