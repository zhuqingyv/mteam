// DriverEvent 单测：验证 12 种事件类型守卫 + 联合类型形状可构造。
// 不涉及 bus / driver 运行时，只校验类型层面与 isDriverEvent 的正反例。
import { describe, it, expect } from 'bun:test';
import type {
  DriverEvent,
  DriverEventType,
  DriverThinkingEvent,
  DriverTextEvent,
  DriverToolCallEvent,
  DriverToolResultEvent,
  DriverToolUpdateEvent,
  DriverPlanEvent,
  DriverCommandsEvent,
  DriverModeEvent,
  DriverConfigEvent,
  DriverSessionInfoEvent,
  DriverUsageEvent,
  DriverTurnStartEvent,
  DriverTurnDoneEvent,
} from '../types.js';
import { isDriverEvent } from '../types.js';

describe('isDriverEvent', () => {
  const validTypes: DriverEventType[] = [
    'driver.thinking',
    'driver.text',
    'driver.tool_call',
    'driver.tool_result',
    'driver.tool_update',
    'driver.plan',
    'driver.commands',
    'driver.mode',
    'driver.config',
    'driver.session_info',
    'driver.usage',
    'driver.turn_start',
    'driver.turn_done',
  ];

  it('recognises all 13 DriverEvent types (12 semantic + 1 deprecated tool_result)', () => {
    expect(validTypes).toHaveLength(13);
    for (const t of validTypes) {
      expect(isDriverEvent({ type: t })).toBe(true);
    }
  });

  it('rejects non-driver types', () => {
    expect(isDriverEvent({ type: 'driver.unknown' })).toBe(false);
    expect(isDriverEvent({ type: 'turn.block_updated' })).toBe(false);
    expect(isDriverEvent({ type: 'comm.message' })).toBe(false);
    expect(isDriverEvent({ type: '' })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isDriverEvent(null)).toBe(false);
    expect(isDriverEvent(undefined)).toBe(false);
    expect(isDriverEvent('driver.text')).toBe(false);
    expect(isDriverEvent(42)).toBe(false);
    expect(isDriverEvent([])).toBe(false);
  });

  it('rejects objects missing type field', () => {
    expect(isDriverEvent({})).toBe(false);
    expect(isDriverEvent({ content: 'hi' })).toBe(false);
  });

  it('rejects objects with non-string type', () => {
    expect(isDriverEvent({ type: 42 })).toBe(false);
    expect(isDriverEvent({ type: null })).toBe(false);
  });
});

describe('DriverEvent shape constructibility', () => {
  it('driver.thinking: messageId optional', () => {
    const ev1: DriverThinkingEvent = { type: 'driver.thinking', content: 'hmm' };
    const ev2: DriverThinkingEvent = { type: 'driver.thinking', messageId: 'msg_1', content: '' };
    expect(ev1.type).toBe('driver.thinking');
    expect(ev2.messageId).toBe('msg_1');
  });

  it('driver.text: messageId optional', () => {
    const ev: DriverTextEvent = { type: 'driver.text', messageId: 'msg_2', content: 'hi' };
    expect(ev.content).toBe('hi');
  });

  it('driver.tool_call: legacy shape (name+input) still valid', () => {
    // 过渡期：老 adapter 传的形状必须仍能通过类型检查
    const legacy: DriverToolCallEvent = {
      type: 'driver.tool_call',
      toolCallId: 'tc_1',
      name: 'Bash',
      input: { cmd: 'ls' },
    };
    expect(legacy.name).toBe('Bash');
  });

  it('driver.tool_call: terminal shape (title+kind+status+locations+content) valid', () => {
    // 过渡期：name 仍必填；T-4/T-5 迁移后由架构师清理。
    const terminal: DriverToolCallEvent = {
      type: 'driver.tool_call',
      toolCallId: 'tc_2',
      name: 'Read /etc/hostname',
      title: 'Read /etc/hostname',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/etc/hostname', line: 1 }],
      input: { vendor: 'claude', display: 'Read /etc/hostname', data: { file_path: '/etc/hostname' } },
      content: [{ kind: 'text', text: 'partial' }],
    };
    expect(terminal.kind).toBe('read');
    expect(terminal.locations?.[0].path).toBe('/etc/hostname');
  });

  it('driver.tool_result: deprecated shape preserved', () => {
    const ev: DriverToolResultEvent = {
      type: 'driver.tool_result',
      toolCallId: 'tc_1',
      output: { stdout: 'hello' },
      ok: true,
    };
    expect(ev.ok).toBe(true);
  });

  it('driver.tool_update: terminal shape valid', () => {
    const ev: DriverToolUpdateEvent = {
      type: 'driver.tool_update',
      toolCallId: 'tc_2',
      status: 'completed',
      title: 'Read done',
      kind: 'read',
      locations: [{ path: '/tmp/x' }],
      output: {
        vendor: 'codex',
        display: 'hello\n',
        exitCode: 0,
        data: { stdout: 'hello\n' },
      },
      content: [{ kind: 'text', text: 'hello' }],
    };
    expect(ev.output?.exitCode).toBe(0);
    expect(ev.output?.vendor).toBe('codex');
  });

  it('driver.plan: entries required', () => {
    const ev: DriverPlanEvent = {
      type: 'driver.plan',
      entries: [
        { content: 'step 1', priority: 'high', status: 'completed' },
        { content: 'step 2', priority: 'medium', status: 'in_progress' },
      ],
    };
    expect(ev.entries).toHaveLength(2);
  });

  it('driver.commands: descriptor list required', () => {
    const ev: DriverCommandsEvent = {
      type: 'driver.commands',
      commands: [
        { name: '/help', description: 'show help' },
        { name: '/mode', description: 'switch mode', inputHint: 'mode-id' },
      ],
    };
    expect(ev.commands).toHaveLength(2);
  });

  it('driver.mode: currentModeId required', () => {
    const ev: DriverModeEvent = { type: 'driver.mode', currentModeId: 'plan' };
    expect(ev.currentModeId).toBe('plan');
  });

  it('driver.config: options required', () => {
    const ev: DriverConfigEvent = {
      type: 'driver.config',
      options: [{
        id: 'thought_level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
      }],
    };
    expect(ev.options[0].category).toBe('thought_level');
  });

  it('driver.session_info: both title and updatedAt optional', () => {
    const ev1: DriverSessionInfoEvent = { type: 'driver.session_info' };
    const ev2: DriverSessionInfoEvent = {
      type: 'driver.session_info',
      title: 'debug session',
      updatedAt: '2026-04-25T12:00:00Z',
    };
    expect(ev1.type).toBe('driver.session_info');
    expect(ev2.title).toBe('debug session');
  });

  it('driver.usage: used+size required, cost optional', () => {
    const ev1: DriverUsageEvent = { type: 'driver.usage', used: 100, size: 1000 };
    const ev2: DriverUsageEvent = {
      type: 'driver.usage',
      used: 500,
      size: 1000,
      cost: { amount: 0.12, currency: 'USD' },
    };
    expect(ev1.used).toBe(100);
    expect(ev2.cost?.amount).toBe(0.12);
  });

  it('driver.turn_start: turnId + userInput required', () => {
    const ev: DriverTurnStartEvent = {
      type: 'driver.turn_start',
      turnId: 'turn_abc',
      userInput: { text: 'hi', ts: '2026-04-25T12:00:00Z' },
    };
    expect(ev.turnId).toBe('turn_abc');
    expect(ev.userInput.text).toBe('hi');
  });

  it('driver.turn_done: legacy stopReason string OK; turnId/usage optional', () => {
    // 老代码：stopReason 传任意字符串
    const legacy: DriverTurnDoneEvent = { type: 'driver.turn_done', stopReason: 'end_turn' };
    // 终态：带 turnId + usage
    const terminal: DriverTurnDoneEvent = {
      type: 'driver.turn_done',
      turnId: 'turn_abc',
      stopReason: 'end_turn',
      usage: { totalTokens: 1234, inputTokens: 800, outputTokens: 434 },
    };
    expect(legacy.turnId).toBeUndefined();
    expect(terminal.usage?.totalTokens).toBe(1234);
  });
});

describe('DriverEvent union exhaustiveness', () => {
  // 编译期验证：switch 覆盖所有 13 个分支后 `_never: never` 可赋值。
  it('switch over all branches is exhaustive', () => {
    function handle(ev: DriverEvent): string {
      switch (ev.type) {
        case 'driver.thinking': return 'thinking';
        case 'driver.text': return 'text';
        case 'driver.tool_call': return 'tool_call';
        case 'driver.tool_result': return 'tool_result';
        case 'driver.tool_update': return 'tool_update';
        case 'driver.plan': return 'plan';
        case 'driver.commands': return 'commands';
        case 'driver.mode': return 'mode';
        case 'driver.config': return 'config';
        case 'driver.session_info': return 'session_info';
        case 'driver.usage': return 'usage';
        case 'driver.turn_start': return 'turn_start';
        case 'driver.turn_done': return 'turn_done';
        default: {
          const _never: never = ev;
          return _never;
        }
      }
    }

    const sample: DriverEvent = { type: 'driver.thinking', content: 'hi' };
    expect(handle(sample)).toBe('thinking');
  });
});
