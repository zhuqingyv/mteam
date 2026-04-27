// T3 · turn-history 订阅器单测。
// 真 EventBus，insertTurn 用注入的 fake（无 DB 依赖）；覆盖 done/error/过滤/异常/退订/turn.error。
import { describe, it, expect } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { subscribeTurnHistory } from './turn-history.subscriber.js';
import type {
  ConfigBlock, ModeBlock, SessionInfoBlock, TextBlock,
  ToolCallBlock, Turn, CommandsBlock,
} from '../../agent-driver/turn-types.js';

const TS = '2026-04-25T00:00:00.000Z';

function mkTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    turnId: 't1', driverId: 'd1', status: 'done',
    userInput: { text: 'hi', ts: TS },
    blocks: [], startTs: TS, endTs: TS,
    stopReason: 'end_turn',
    ...overrides,
  };
}

function emitCompleted(bus: EventBus, turn: Turn): void {
  bus.emit({ ...makeBase('turn.completed', 'test'), driverId: turn.driverId, turnId: turn.turnId, turn });
}

describe('turn-history.subscriber', () => {
  it('status=done → insertTurn 被调，整 Turn 原样落库', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    subscribeTurnHistory(bus, { insertTurn: (t) => calls.push(t) });
    const text: TextBlock = { blockId: 'b0', type: 'text', scope: 'turn', status: 'done', seq: 0, startTs: TS, updatedTs: TS, content: 'hello' };
    const tool: ToolCallBlock = {
      blockId: 'b1', type: 'tool_call', scope: 'turn', status: 'done', seq: 1, startTs: TS, updatedTs: TS,
      toolCallId: 'b1', title: 'ls', toolStatus: 'completed',
      input: { vendor: 'claude', display: '.', data: null },
    };
    emitCompleted(bus, mkTurn({ blocks: [text, tool] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].turnId).toBe('t1');
    expect(calls[0].blocks).toEqual([text, tool]);
  });

  it('status=error（崩溃）也落库', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    subscribeTurnHistory(bus, { insertTurn: (t) => calls.push(t) });
    emitCompleted(bus, mkTurn({ status: 'error', stopReason: 'crashed' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('error');
    expect(calls[0].stopReason).toBe('crashed');
  });

  it('session-scope blocks 落库前被过滤（commands/mode/config/session_info）', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    subscribeTurnHistory(bus, { insertTurn: (t) => calls.push(t) });
    const text: TextBlock = { blockId: 'b0', type: 'text', scope: 'turn', status: 'done', seq: 0, startTs: TS, updatedTs: TS, content: 'x' };
    const mode: ModeBlock = { blockId: 'mode', type: 'mode', scope: 'session', status: 'done', seq: 1, startTs: TS, updatedTs: TS, currentModeId: 'ask' };
    const config: ConfigBlock = { blockId: 'config', type: 'config', scope: 'session', status: 'done', seq: 2, startTs: TS, updatedTs: TS, options: [] };
    const info: SessionInfoBlock = { blockId: 'session_info', type: 'session_info', scope: 'session', status: 'done', seq: 3, startTs: TS, updatedTs: TS };
    const cmds: CommandsBlock = { blockId: 'commands', type: 'commands', scope: 'session', status: 'done', seq: 4, startTs: TS, updatedTs: TS, commands: [] };
    const tool: ToolCallBlock = {
      blockId: 'b5', type: 'tool_call', scope: 'turn', status: 'done', seq: 5, startTs: TS, updatedTs: TS,
      toolCallId: 'b5', title: 't', toolStatus: 'completed',
      input: { vendor: 'claude', display: '', data: null },
    };
    emitCompleted(bus, mkTurn({ blocks: [text, mode, config, info, cmds, tool] }));
    expect(calls[0].blocks.map((b) => b.type)).toEqual(['text', 'tool_call']);
  });

  it('insertTurn 抛异常 → stderr 打日志 + 订阅不断流（下一条仍能处理）', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    let first = true;
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrCapture = '';
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      subscribeTurnHistory(bus, { insertTurn: (t) => {
        if (first) { first = false; throw new Error('disk full'); }
        calls.push(t);
      } });
      emitCompleted(bus, mkTurn({ turnId: 't1' }));
      emitCompleted(bus, mkTurn({ turnId: 't2' }));
    } finally {
      process.stderr.write = origWrite;
    }
    expect(stderrCapture).toContain('[turn-history] insert failed');
    expect(stderrCapture).toContain('disk full');
    expect(calls).toHaveLength(1);
    expect(calls[0].turnId).toBe('t2');
  });

  it('退订后新 emit 不再落库', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    const sub = subscribeTurnHistory(bus, { insertTurn: (t) => calls.push(t) });
    emitCompleted(bus, mkTurn({ turnId: 't1' }));
    sub.unsubscribe();
    emitCompleted(bus, mkTurn({ turnId: 't2' }));
    expect(calls.map((t) => t.turnId)).toEqual(['t1']);
  });

  it('turn.error 事件不触发落库（aggregator 已先 emit completed）', () => {
    const bus = new EventBus();
    const calls: Turn[] = [];
    subscribeTurnHistory(bus, { insertTurn: (t) => calls.push(t) });
    bus.emit({ ...makeBase('turn.error', 'test'), driverId: 'd1', turnId: 't1', message: 'boom' });
    expect(calls).toHaveLength(0);
  });
});
