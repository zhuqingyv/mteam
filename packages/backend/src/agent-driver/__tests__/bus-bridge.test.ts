// bus-bridge 单测：验证 attachDriverToBus 把 DriverOutputEvent 正确翻译成
// bus.BusEvent。全部用例不 mock bus（WORKFLOW §6.3），每个 suite 用 new EventBus()
// 隔离实例，避免与 bus-integration.test.ts 的全局 bus.destroy() 串扰。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Subject, type Subscription } from 'rxjs';
import { EventBus } from '../../bus/events.js';
import type { BusEvent } from '../../bus/types.js';
import {
  attachDriverToBus,
  type DriverOutputEvent,
} from '../bus-bridge.js';

// 仅收集 driver.* 事件，避免其他后台 subscriber 干扰。
function collectDriverEvents(bus: EventBus): { events: BusEvent[]; stop: () => void } {
  const events: BusEvent[] = [];
  const sub = bus.events$.subscribe((ev) => {
    if (ev.type.startsWith('driver.')) events.push(ev);
  });
  return { events, stop: () => sub.unsubscribe() };
}

describe('attachDriverToBus', () => {
  let bus: EventBus;
  let subject: Subject<DriverOutputEvent>;
  let attached: Subscription;
  let captured: { events: BusEvent[]; stop: () => void };

  beforeEach(() => {
    bus = new EventBus();
    subject = new Subject<DriverOutputEvent>();
    attached = attachDriverToBus('d1', subject.asObservable(), bus);
    captured = collectDriverEvents(bus);
  });

  afterEach(() => {
    attached.unsubscribe();
    captured.stop();
    subject.complete();
    bus.destroy();
  });

  it('translates driver.started', () => {
    subject.next({ type: 'driver.started' });
    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.started');
    expect((ev as { driverId: string }).driverId).toBe('d1');
    expect((ev as { source: string }).source).toBe('agent-driver');
    expect((ev as { ts: string }).ts).toBeDefined();
    expect((ev as { pid?: number }).pid).toBeUndefined();
  });

  it('translates driver.started with pid passthrough', () => {
    subject.next({ type: 'driver.started', pid: 4242 });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.started');
    expect((ev as { driverId: string }).driverId).toBe('d1');
    expect((ev as { pid?: number | string }).pid).toBe(4242);
  });

  it('translates driver.stopped', () => {
    subject.next({ type: 'driver.stopped' });
    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.stopped');
    expect((ev as { driverId: string }).driverId).toBe('d1');
  });

  it('translates driver.error with message', () => {
    subject.next({ type: 'driver.error', message: 'boom' });
    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.error');
    expect((ev as { driverId: string }).driverId).toBe('d1');
    expect((ev as { message: string }).message).toBe('boom');
  });

  it('translates driver.thinking with content', () => {
    subject.next({ type: 'driver.thinking', content: 'hmm' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.thinking');
    expect((ev as { driverId: string }).driverId).toBe('d1');
    expect((ev as { content: string }).content).toBe('hmm');
  });

  it('translates driver.text with content', () => {
    subject.next({ type: 'driver.text', content: 'hello' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.text');
    expect((ev as { content: string }).content).toBe('hello');
  });

  it('translates driver.tool_call with name + normalized input', () => {
    subject.next({
      type: 'driver.tool_call',
      toolCallId: 't1',
      name: 'Bash',
      input: { cmd: 'ls' },
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.tool_call');
    expect((ev as { name: string }).name).toBe('Bash');
    expect((ev as { input: Record<string, unknown> }).input).toEqual({ cmd: 'ls' });
  });

  it('normalizes non-object tool_call input to empty record', () => {
    subject.next({
      type: 'driver.tool_call',
      toolCallId: 't1',
      name: 'Read',
      input: null,
    });
    const ev = captured.events[0];
    expect((ev as { input: Record<string, unknown> }).input).toEqual({});
  });

  it('translates driver.tool_result (driverId only)', () => {
    subject.next({
      type: 'driver.tool_result',
      toolCallId: 't1',
      output: {},
      ok: true,
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.tool_result');
    expect((ev as { driverId: string }).driverId).toBe('d1');
  });

  it('translates driver.turn_done (stopReason not propagated)', () => {
    subject.next({ type: 'driver.turn_done', stopReason: 'end_turn' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.turn_done');
    expect((ev as { driverId: string }).driverId).toBe('d1');
  });

  // ---------- T-8 扩展：7 新 driver 事件 + 已有事件的新字段透传 ----------

  it('T-8 propagates thinking.messageId when present', () => {
    subject.next({ type: 'driver.thinking', messageId: 'm1', content: 'hmm' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.thinking');
    expect((ev as { messageId?: string }).messageId).toBe('m1');
    expect((ev as { content: string }).content).toBe('hmm');
  });

  it('T-8 omits thinking.messageId when adapter did not fill it', () => {
    subject.next({ type: 'driver.thinking', content: 'raw' });
    const ev = captured.events[0];
    expect('messageId' in (ev as object)).toBe(false);
  });

  it('T-8 propagates text.messageId when present', () => {
    subject.next({ type: 'driver.text', messageId: 'msg_42', content: 'hi' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.text');
    expect((ev as { messageId?: string }).messageId).toBe('msg_42');
  });

  it('T-8 propagates tool_call terminal fields (toolCallId/title/kind/status/locations/content)', () => {
    subject.next({
      type: 'driver.tool_call',
      toolCallId: 'c1',
      name: 'Read',
      title: 'Read /tmp/x',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/tmp/x', line: 3 }],
      input: { vendor: 'claude', display: 'Read /tmp/x', data: { file_path: '/tmp/x' } },
      content: [{ kind: 'text', text: 'preview' }],
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.tool_call');
    expect((ev as { name: string }).name).toBe('Read');
    expect((ev as { toolCallId?: string }).toolCallId).toBe('c1');
    expect((ev as { title?: string }).title).toBe('Read /tmp/x');
    expect((ev as { kind?: string }).kind).toBe('read');
    expect((ev as { status?: string }).status).toBe('in_progress');
    expect((ev as { locations?: unknown[] }).locations).toEqual([{ path: '/tmp/x', line: 3 }]);
    expect((ev as { content?: unknown[] }).content).toEqual([{ kind: 'text', text: 'preview' }]);
    expect((ev as { input: Record<string, unknown> }).input).toEqual({
      vendor: 'claude', display: 'Read /tmp/x', data: { file_path: '/tmp/x' },
    });
  });

  it('T-8 translates driver.tool_update terminal shape', () => {
    subject.next({
      type: 'driver.tool_update',
      toolCallId: 'c1',
      status: 'completed',
      output: { vendor: 'codex', display: 'ok', data: { stdout: 'ok' }, exitCode: 0 },
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.tool_update');
    expect((ev as { driverId: string }).driverId).toBe('d1');
    expect((ev as { toolCallId: string }).toolCallId).toBe('c1');
    expect((ev as { status?: string }).status).toBe('completed');
    expect((ev as { output?: Record<string, unknown> }).output).toEqual({
      vendor: 'codex', display: 'ok', data: { stdout: 'ok' }, exitCode: 0,
    });
  });

  it('T-8 omits optional tool_update fields when adapter did not fill them', () => {
    subject.next({ type: 'driver.tool_update', toolCallId: 'c1' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.tool_update');
    expect((ev as { toolCallId: string }).toolCallId).toBe('c1');
    for (const k of ['status', 'title', 'kind', 'locations', 'output', 'content']) {
      expect(k in (ev as object)).toBe(false);
    }
  });

  it('T-8 translates driver.plan with entries', () => {
    const entries = [
      { content: '读文件', priority: 'high' as const, status: 'completed' as const },
      { content: '写结论', priority: 'medium' as const, status: 'pending' as const },
    ];
    subject.next({ type: 'driver.plan', entries });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.plan');
    expect((ev as { entries: typeof entries }).entries).toEqual(entries);
  });

  it('T-8 translates driver.commands', () => {
    const commands = [{ name: 'help', description: '显示帮助' }];
    subject.next({ type: 'driver.commands', commands });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.commands');
    expect((ev as { commands: typeof commands }).commands).toEqual(commands);
  });

  it('T-8 translates driver.mode', () => {
    subject.next({ type: 'driver.mode', currentModeId: 'readonly' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.mode');
    expect((ev as { currentModeId: string }).currentModeId).toBe('readonly');
  });

  it('T-8 translates driver.config', () => {
    const options = [
      {
        id: 'model',
        category: 'model' as const,
        type: 'select' as const,
        currentValue: 'opus',
        options: [{ id: 'opus', name: 'Opus' }],
      },
    ];
    subject.next({ type: 'driver.config', options });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.config');
    expect((ev as { options: typeof options }).options).toEqual(options);
  });

  it('T-8 translates driver.session_info with partial fields', () => {
    subject.next({ type: 'driver.session_info', title: '分析 x.txt' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.session_info');
    expect((ev as { title?: string }).title).toBe('分析 x.txt');
    expect('updatedAt' in (ev as object)).toBe(false);
  });

  it('T-8 translates driver.session_info with no fields (adapter 不填)', () => {
    subject.next({ type: 'driver.session_info' });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.session_info');
    expect('title' in (ev as object)).toBe(false);
    expect('updatedAt' in (ev as object)).toBe(false);
  });

  it('T-8 translates driver.usage with cost', () => {
    subject.next({
      type: 'driver.usage',
      used: 8284, size: 258400,
      cost: { amount: 0.12, currency: 'USD' },
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.usage');
    expect((ev as { used: number }).used).toBe(8284);
    expect((ev as { size: number }).size).toBe(258400);
    expect((ev as { cost?: { amount: number; currency: string } }).cost).toEqual({
      amount: 0.12, currency: 'USD',
    });
  });

  it('T-8 translates driver.usage without cost', () => {
    subject.next({ type: 'driver.usage', used: 100, size: 1000 });
    const ev = captured.events[0];
    expect('cost' in (ev as object)).toBe(false);
  });

  it('T-8 translates driver.turn_start with turnId + userInput', () => {
    const userInput = { text: '分析 /tmp/x', ts: '2026-04-25T12:00:00Z' };
    subject.next({ type: 'driver.turn_start', turnId: 'turn_1', userInput });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.turn_start');
    expect((ev as { turnId: string }).turnId).toBe('turn_1');
    expect((ev as { userInput: typeof userInput }).userInput).toEqual(userInput);
  });

  it('T-8 translates driver.turn_done with turnId/stopReason/usage', () => {
    subject.next({
      type: 'driver.turn_done',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { totalTokens: 1234, inputTokens: 800, outputTokens: 434 },
    });
    const ev = captured.events[0];
    expect(ev.type).toBe('driver.turn_done');
    expect((ev as { turnId?: string }).turnId).toBe('turn_1');
    expect((ev as { stopReason?: string }).stopReason).toBe('end_turn');
    expect((ev as { usage?: Record<string, unknown> }).usage).toEqual({
      totalTokens: 1234, inputTokens: 800, outputTokens: 434,
    });
  });
});

describe('attachDriverToBus — multi-driver isolation', () => {
  it('does not cross streams between driver ids', () => {
    const bus = new EventBus();
    const subjA = new Subject<DriverOutputEvent>();
    const subjB = new Subject<DriverOutputEvent>();
    const subA = attachDriverToBus('a', subjA.asObservable(), bus);
    const subB = attachDriverToBus('b', subjB.asObservable(), bus);
    const captured = collectDriverEvents(bus);

    subjA.next({ type: 'driver.started' });
    subjB.next({ type: 'driver.error', message: 'fail' });

    expect(captured.events).toHaveLength(2);
    const startedA = captured.events.find((e) => e.type === 'driver.started');
    const errorB = captured.events.find((e) => e.type === 'driver.error');
    expect((startedA as { driverId: string }).driverId).toBe('a');
    expect((errorB as { driverId: string }).driverId).toBe('b');
    expect((errorB as { message: string }).message).toBe('fail');

    subA.unsubscribe();
    subB.unsubscribe();
    captured.stop();
    subjA.complete();
    subjB.complete();
    bus.destroy();
  });
});

describe('attachDriverToBus — subscription lifecycle', () => {
  it('subscription closes when source observable completes', () => {
    const bus = new EventBus();
    const subj = new Subject<DriverOutputEvent>();
    const sub = attachDriverToBus('d1', subj.asObservable(), bus);
    expect(sub.closed).toBe(false);
    subj.complete();
    expect(sub.closed).toBe(true);
    bus.destroy();
  });

  it('unsubscribe stops further translations', () => {
    const bus = new EventBus();
    const subj = new Subject<DriverOutputEvent>();
    const sub = attachDriverToBus('d1', subj.asObservable(), bus);
    const captured = collectDriverEvents(bus);

    subj.next({ type: 'driver.started' });
    expect(captured.events).toHaveLength(1);

    sub.unsubscribe();
    subj.next({ type: 'driver.stopped' });
    expect(captured.events).toHaveLength(1);

    captured.stop();
    subj.complete();
    bus.destroy();
  });
});
