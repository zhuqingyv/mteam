// T-7 单测：bus 侧 driver.* 新增事件类型契约冻结。
//
// T-7 在 driver-events.ts（从 types.ts 拆出）新增 8 条事件：
//   tool_update / plan / commands / mode / config / session_info / usage / turn_start
// 以及对 thinking / text 扩 messageId、turn_done 扩 turnId/stopReason/usage。
//
// 本测试只关心 bus 侧形状与路由：DriverEvent → BusEvent 翻译由 T-8 bus-bridge 负责，
// 其单测在 agent-driver/__tests__/bus-bridge.test.ts。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import type {
  BusEvent,
  DriverPlanEvent,
  DriverCommandsEvent,
  DriverModeEvent,
  DriverConfigEvent,
  DriverSessionInfoEvent,
  DriverUsageEvent,
  DriverTurnStartEvent,
  DriverToolUpdateEvent,
  DriverThinkingEvent,
  DriverTextEvent,
  DriverTurnDoneEvent,
} from '../types.js';

const SOURCE = 'test:driver-events';

describe('T-7 · bus driver.* 新增事件契约', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  it('driver.tool_update：toolCallId 必填，其他可选', () => {
    const received: DriverToolUpdateEvent[] = [];
    const sub = bus.on('driver.tool_update').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.tool_update', SOURCE),
      driverId: 'd1',
      toolCallId: 'c1',
      status: 'completed',
      output: { vendor: 'codex', display: 'ok', data: { stdout: 'ok' }, exitCode: 0 },
    });
    bus.emit({
      ...makeBase('driver.tool_update', SOURCE),
      driverId: 'd1',
      toolCallId: 'c2',
    });

    expect(received.length).toBe(2);
    expect(received[0]!.toolCallId).toBe('c1');
    expect(received[0]!.output?.display).toBe('ok');
    expect(received[0]!.output?.exitCode).toBe(0);
    expect(received[1]!.toolCallId).toBe('c2');
    expect(received[1]!.output).toBeUndefined();
    sub.unsubscribe();
  });

  it('driver.plan：entries 全量替换本 turn 的 plan', () => {
    const received: DriverPlanEvent[] = [];
    const sub = bus.on('driver.plan').subscribe((e) => received.push(e));

    const entries: DriverPlanEvent['entries'] = [
      { content: '读文件', priority: 'high', status: 'completed' },
      { content: '写结论', priority: 'medium', status: 'pending' },
    ];
    bus.emit({ ...makeBase('driver.plan', SOURCE), driverId: 'd1', entries });

    expect(received[0]!.entries).toEqual(entries);
    sub.unsubscribe();
  });

  it('driver.commands：会话级 slash-command 列表透传', () => {
    const received: DriverCommandsEvent[] = [];
    const sub = bus.on('driver.commands').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.commands', SOURCE),
      driverId: 'd1',
      commands: [
        { name: 'help', description: '显示帮助' },
        { name: 'model', description: '切换模型', inputHint: 'gpt-5 | claude' },
      ],
    });

    expect(received[0]!.commands.length).toBe(2);
    expect(received[0]!.commands[1]!.inputHint).toBe('gpt-5 | claude');
    sub.unsubscribe();
  });

  it('driver.mode：currentModeId 透传', () => {
    const received: DriverModeEvent[] = [];
    const sub = bus.on('driver.mode').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.mode', SOURCE),
      driverId: 'd1',
      currentModeId: 'plan',
    });

    expect(received[0]!.currentModeId).toBe('plan');
    sub.unsubscribe();
  });

  it('driver.config：options 数组透传', () => {
    const received: DriverConfigEvent[] = [];
    const sub = bus.on('driver.config').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.config', SOURCE),
      driverId: 'd1',
      options: [
        { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5' },
      ],
    });

    expect(received[0]!.options.length).toBe(1);
    expect(received[0]!.options[0]!.currentValue).toBe('gpt-5');
    sub.unsubscribe();
  });

  it('driver.session_info：title / updatedAt 可选', () => {
    const received: DriverSessionInfoEvent[] = [];
    const sub = bus.on('driver.session_info').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.session_info', SOURCE),
      driverId: 'd1',
      title: 'my session',
    });
    bus.emit({ ...makeBase('driver.session_info', SOURCE), driverId: 'd1' });

    expect(received[0]!.title).toBe('my session');
    expect(received[1]!.title).toBeUndefined();
    sub.unsubscribe();
  });

  it('driver.usage：used / size 必填，cost 可选', () => {
    const received: DriverUsageEvent[] = [];
    const sub = bus.on('driver.usage').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.usage', SOURCE),
      driverId: 'd1',
      used: 1000,
      size: 200000,
    });
    bus.emit({
      ...makeBase('driver.usage', SOURCE),
      driverId: 'd1',
      used: 2000,
      size: 200000,
      cost: { amount: 0.05, currency: 'USD' },
    });

    expect(received[0]!.used).toBe(1000);
    expect(received[0]!.cost).toBeUndefined();
    expect(received[1]!.cost?.amount).toBe(0.05);
    sub.unsubscribe();
  });

  it('driver.turn_start：turnId + userInput 必填', () => {
    const received: DriverTurnStartEvent[] = [];
    const sub = bus.on('driver.turn_start').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.turn_start', SOURCE),
      driverId: 'd1',
      turnId: 'turn_abc',
      userInput: { text: '分析文件', ts: '2026-04-25T12:00:00Z' },
    });

    expect(received[0]!.turnId).toBe('turn_abc');
    expect(received[0]!.userInput.text).toBe('分析文件');
    sub.unsubscribe();
  });

  // --- T-7 对既有事件的扩字段 ---

  it('driver.thinking：messageId 可选（同 messageId 的 chunk 合并为一个 Block）', () => {
    const received: DriverThinkingEvent[] = [];
    const sub = bus.on('driver.thinking').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.thinking', SOURCE),
      driverId: 'd1',
      content: '思考中...',
      messageId: 'msg_1',
    });
    bus.emit({
      ...makeBase('driver.thinking', SOURCE),
      driverId: 'd1',
      content: '老形状：不带 messageId',
    });

    expect(received[0]!.messageId).toBe('msg_1');
    expect(received[1]!.messageId).toBeUndefined();
    sub.unsubscribe();
  });

  it('driver.text：messageId 可选，老 payload 仍兼容', () => {
    const received: DriverTextEvent[] = [];
    const sub = bus.on('driver.text').subscribe((e) => received.push(e));

    bus.emit({
      ...makeBase('driver.text', SOURCE),
      driverId: 'd1',
      content: '回复',
      messageId: 'msg_2',
    });

    expect(received[0]!.messageId).toBe('msg_2');
    expect(received[0]!.content).toBe('回复');
    sub.unsubscribe();
  });

  it('driver.turn_done：turnId / stopReason / usage 全部可选（过渡期兼容老 emit 点）', () => {
    const received: DriverTurnDoneEvent[] = [];
    const sub = bus.on('driver.turn_done').subscribe((e) => received.push(e));

    // 老形状：只有 driverId
    bus.emit({ ...makeBase('driver.turn_done', SOURCE), driverId: 'd1' });
    // 新形状：全字段
    bus.emit({
      ...makeBase('driver.turn_done', SOURCE),
      driverId: 'd1',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { totalTokens: 1234, inputTokens: 800, outputTokens: 434 },
    });

    expect(received[0]!.turnId).toBeUndefined();
    expect(received[1]!.turnId).toBe('turn_1');
    expect(received[1]!.usage?.totalTokens).toBe(1234);
    expect(received[1]!.stopReason).toBe('end_turn');
    sub.unsubscribe();
  });

  // --- onPrefix 路由完整性 ---

  it('onPrefix("driver.") 能收到 T-7 全部 8 条新增 driver.*', () => {
    const types: string[] = [];
    const sub = bus.onPrefix('driver.').subscribe((e) => types.push(e.type));

    bus.emit({
      ...makeBase('driver.tool_update', SOURCE),
      driverId: 'd1',
      toolCallId: 'c1',
    });
    bus.emit({ ...makeBase('driver.plan', SOURCE), driverId: 'd1', entries: [] });
    bus.emit({
      ...makeBase('driver.commands', SOURCE),
      driverId: 'd1',
      commands: [],
    });
    bus.emit({ ...makeBase('driver.mode', SOURCE), driverId: 'd1', currentModeId: 'x' });
    bus.emit({ ...makeBase('driver.config', SOURCE), driverId: 'd1', options: [] });
    bus.emit({ ...makeBase('driver.session_info', SOURCE), driverId: 'd1' });
    bus.emit({ ...makeBase('driver.usage', SOURCE), driverId: 'd1', used: 1, size: 2 });
    bus.emit({
      ...makeBase('driver.turn_start', SOURCE),
      driverId: 'd1',
      turnId: 't',
      userInput: { text: '', ts: '2026-04-25T12:00:00Z' },
    });

    expect(types).toEqual([
      'driver.tool_update',
      'driver.plan',
      'driver.commands',
      'driver.mode',
      'driver.config',
      'driver.session_info',
      'driver.usage',
      'driver.turn_start',
    ]);
    sub.unsubscribe();
  });

  it('非 driver.* 事件不会被 onPrefix("driver.") 误收', () => {
    const types: string[] = [];
    const sub = bus.onPrefix('driver.').subscribe((e) => types.push(e.type));

    bus.emit({
      ...makeBase('turn.started', SOURCE),
      driverId: 'd1',
      turnId: 't',
      userInput: { text: '', ts: '2026-04-25T12:00:00Z' },
    } as BusEvent);

    expect(types).toEqual([]);
    sub.unsubscribe();
  });
});
