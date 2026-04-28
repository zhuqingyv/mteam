import { describe, it, expect } from 'bun:test';
import { isWsUpstream, type WsDownstream, type WsUpstream } from './protocol.js';

describe('isWsUpstream · 正例（必填字段齐全）', () => {
  it('subscribe global 无 id', () => {
    expect(isWsUpstream({ op: 'subscribe', scope: 'global' })).toBe(true);
  });

  it('subscribe team 带 id', () => {
    expect(isWsUpstream({ op: 'subscribe', scope: 'team', id: 'team_01' })).toBe(true);
  });

  it('subscribe instance 带 lastMsgId', () => {
    expect(
      isWsUpstream({
        op: 'subscribe',
        scope: 'instance',
        id: 'inst_1',
        lastMsgId: 'msg_123',
      }),
    ).toBe(true);
  });

  it('subscribe user', () => {
    expect(isWsUpstream({ op: 'subscribe', scope: 'user', id: 'u1' })).toBe(true);
  });

  it('unsubscribe team', () => {
    expect(isWsUpstream({ op: 'unsubscribe', scope: 'team', id: 't1' })).toBe(true);
  });

  it('unsubscribe global 无 id', () => {
    expect(isWsUpstream({ op: 'unsubscribe', scope: 'global' })).toBe(true);
  });

  it('prompt 必填最小形态', () => {
    expect(isWsUpstream({ op: 'prompt', instanceId: 'i1', text: 'hi' })).toBe(true);
  });

  it('prompt 带 requestId', () => {
    expect(
      isWsUpstream({ op: 'prompt', instanceId: 'i1', text: 'hi', requestId: 'r1' }),
    ).toBe(true);
  });

  it('ping', () => {
    expect(isWsUpstream({ op: 'ping' })).toBe(true);
  });

  it('configure_primary_agent 最小形态（仅 cliType）', () => {
    expect(
      isWsUpstream({ op: 'configure_primary_agent', cliType: 'codex' }),
    ).toBe(true);
  });

  it('configure_primary_agent 带 name + systemPrompt + requestId', () => {
    expect(
      isWsUpstream({
        op: 'configure_primary_agent',
        cliType: 'claude',
        name: 'MTEAM',
        systemPrompt: 'you are helpful',
        requestId: 'r1',
      }),
    ).toBe(true);
  });

  it('get_turns 最小形态（仅 driverId）', () => {
    expect(isWsUpstream({ op: 'get_turns', driverId: 'd1' })).toBe(true);
  });

  it('get_turns 带 limit + requestId', () => {
    expect(
      isWsUpstream({ op: 'get_turns', driverId: 'd1', limit: 20, requestId: 'r1' }),
    ).toBe(true);
  });

  it('get_turn_history 最小形态（仅 driverId）', () => {
    expect(isWsUpstream({ op: 'get_turn_history', driverId: 'd1' })).toBe(true);
  });

  it('get_turn_history 带完整游标 + limit + requestId', () => {
    expect(
      isWsUpstream({
        op: 'get_turn_history',
        driverId: 'd1',
        limit: 10,
        beforeEndTs: '2026-04-25T00:00:00.000Z',
        beforeTurnId: 't_prev',
        requestId: 'r1',
      }),
    ).toBe(true);
  });

  it('get_workers 无参 / 带 requestId', () => {
    expect(isWsUpstream({ op: 'get_workers' })).toBe(true);
    expect(isWsUpstream({ op: 'get_workers', requestId: 'r1' })).toBe(true);
  });

  it('get_workers 多余字段拒', () => {
    expect(isWsUpstream({ op: 'get_workers', driverId: 'x' })).toBe(false);
  });

  it('get_worker_activity 最小 / 带 workerName+requestId', () => {
    expect(isWsUpstream({ op: 'get_worker_activity', range: 'day' })).toBe(true);
    expect(
      isWsUpstream({ op: 'get_worker_activity', range: 'day', workerName: 'alpha', requestId: 'r' }),
    ).toBe(true);
  });

  it('get_worker_activity 缺 range / range 非串 → 拒', () => {
    expect(isWsUpstream({ op: 'get_worker_activity' })).toBe(false);
    expect(isWsUpstream({ op: 'get_worker_activity', range: '' })).toBe(false);
    expect(isWsUpstream({ op: 'get_worker_activity', range: 42 })).toBe(false);
  });

  it('get_worker_activity 多余字段拒', () => {
    expect(
      isWsUpstream({ op: 'get_worker_activity', range: 'day', extra: 'x' }),
    ).toBe(false);
  });
});

describe('isWsUpstream · 反例', () => {
  it('null / undefined / 原始值一律拒', () => {
    expect(isWsUpstream(null)).toBe(false);
    expect(isWsUpstream(undefined)).toBe(false);
    expect(isWsUpstream('subscribe')).toBe(false);
    expect(isWsUpstream(42)).toBe(false);
    expect(isWsUpstream(true)).toBe(false);
  });

  it('数组被拒（Object.keys 能跑但不是消息）', () => {
    expect(isWsUpstream([])).toBe(false);
    expect(isWsUpstream([{ op: 'ping' }])).toBe(false);
  });

  it('op 拼写错误', () => {
    expect(isWsUpstream({ op: 'Subscribe', scope: 'team', id: 't1' })).toBe(false);
    expect(isWsUpstream({ op: 'sub', scope: 'team', id: 't1' })).toBe(false);
    expect(isWsUpstream({ op: 'foo' })).toBe(false);
  });

  it('op 缺失', () => {
    expect(isWsUpstream({ scope: 'team', id: 't1' })).toBe(false);
  });

  it('subscribe scope 不在枚举', () => {
    expect(isWsUpstream({ op: 'subscribe', scope: 'teams', id: 't1' })).toBe(false);
    expect(isWsUpstream({ op: 'subscribe', scope: '', id: 't1' })).toBe(false);
  });

  it('subscribe id 类型错', () => {
    expect(isWsUpstream({ op: 'subscribe', scope: 'team', id: 123 })).toBe(false);
    expect(isWsUpstream({ op: 'subscribe', scope: 'team', id: null })).toBe(false);
  });

  it('subscribe lastMsgId 不是 string（数字被拒，防止前端传数字 id）', () => {
    expect(
      isWsUpstream({ op: 'subscribe', scope: 'team', id: 't1', lastMsgId: 1000 }),
    ).toBe(false);
  });

  it('subscribe 带多余字段', () => {
    expect(
      isWsUpstream({ op: 'subscribe', scope: 'team', id: 't1', extra: 'x' }),
    ).toBe(false);
  });

  it('prompt 缺 instanceId / 空串', () => {
    expect(isWsUpstream({ op: 'prompt', text: 'hi' })).toBe(false);
    expect(isWsUpstream({ op: 'prompt', instanceId: '', text: 'hi' })).toBe(false);
  });

  it('prompt text 类型错', () => {
    expect(isWsUpstream({ op: 'prompt', instanceId: 'i1', text: 123 })).toBe(false);
    expect(isWsUpstream({ op: 'prompt', instanceId: 'i1' })).toBe(false);
  });

  it('prompt requestId 类型错', () => {
    expect(
      isWsUpstream({
        op: 'prompt',
        instanceId: 'i1',
        text: 'hi',
        requestId: 7,
      }),
    ).toBe(false);
  });

  it('ping 带多余字段', () => {
    expect(isWsUpstream({ op: 'ping', ts: '2026-04-25' })).toBe(false);
  });

  it('unsubscribe scope 错 / id 类型错', () => {
    expect(isWsUpstream({ op: 'unsubscribe', scope: 'all' })).toBe(false);
    expect(isWsUpstream({ op: 'unsubscribe', scope: 'team', id: 1 })).toBe(false);
  });

  it('configure_primary_agent 缺 cliType', () => {
    expect(isWsUpstream({ op: 'configure_primary_agent' })).toBe(false);
  });

  it('configure_primary_agent 空串 cliType', () => {
    expect(
      isWsUpstream({ op: 'configure_primary_agent', cliType: '' }),
    ).toBe(false);
  });

  it('configure_primary_agent cliType 类型错', () => {
    expect(
      isWsUpstream({ op: 'configure_primary_agent', cliType: 123 }),
    ).toBe(false);
  });

  it('configure_primary_agent 多余字段', () => {
    expect(
      isWsUpstream({
        op: 'configure_primary_agent',
        cliType: 'codex',
        mcpConfig: [],
      }),
    ).toBe(false);
  });

  it('configure_primary_agent name / systemPrompt 类型错', () => {
    expect(
      isWsUpstream({
        op: 'configure_primary_agent',
        cliType: 'codex',
        name: 42,
      }),
    ).toBe(false);
    expect(
      isWsUpstream({
        op: 'configure_primary_agent',
        cliType: 'codex',
        systemPrompt: null,
      }),
    ).toBe(false);
  });

  it('get_turns driverId 空串 / 缺失 / 类型错', () => {
    expect(isWsUpstream({ op: 'get_turns', driverId: '' })).toBe(false);
    expect(isWsUpstream({ op: 'get_turns' })).toBe(false);
    expect(isWsUpstream({ op: 'get_turns', driverId: 42 })).toBe(false);
  });

  it('get_turns limit 非正整数', () => {
    expect(isWsUpstream({ op: 'get_turns', driverId: 'd1', limit: 0 })).toBe(false);
    expect(isWsUpstream({ op: 'get_turns', driverId: 'd1', limit: -1 })).toBe(false);
    expect(isWsUpstream({ op: 'get_turns', driverId: 'd1', limit: 1.5 })).toBe(false);
    expect(isWsUpstream({ op: 'get_turns', driverId: 'd1', limit: '10' })).toBe(false);
  });

  it('get_turns 多余字段', () => {
    expect(
      isWsUpstream({ op: 'get_turns', driverId: 'd1', extra: 'x' }),
    ).toBe(false);
  });

  it('get_turn_history driverId 空串 / 缺失', () => {
    expect(isWsUpstream({ op: 'get_turn_history', driverId: '' })).toBe(false);
    expect(isWsUpstream({ op: 'get_turn_history' })).toBe(false);
  });

  it('get_turn_history 游标字段类型错', () => {
    expect(
      isWsUpstream({ op: 'get_turn_history', driverId: 'd1', beforeEndTs: 123 }),
    ).toBe(false);
    expect(
      isWsUpstream({ op: 'get_turn_history', driverId: 'd1', beforeTurnId: null }),
    ).toBe(false);
  });

  it('get_turn_history 多余字段', () => {
    expect(
      isWsUpstream({ op: 'get_turn_history', driverId: 'd1', unknown: 'x' }),
    ).toBe(false);
  });
});

describe('类型层级 · 编译期断言', () => {
  it('WsUpstream 判别联合可被守卫收窄', () => {
    const raw: unknown = { op: 'prompt', instanceId: 'i1', text: 'hi' };
    if (isWsUpstream(raw)) {
      const msg: WsUpstream = raw;
      // switch 必须能覆盖所有分支；否则 TS 会 never 报错。
      switch (msg.op) {
        case 'subscribe':
        case 'unsubscribe':
        case 'prompt':
        case 'ping':
        case 'configure_primary_agent':
        case 'get_turns':
        case 'get_turn_history':
          expect(true).toBe(true);
          break;
        default: {
          const _n: never = msg;
          void _n;
        }
      }
    }
  });

  it('WsDownstream 字面量形状可构造', () => {
    const samples: WsDownstream[] = [
      { type: 'event', id: 'msg_1', event: { type: 'team.created' } },
      { type: 'gap-replay', items: [], upTo: null },
      { type: 'pong', ts: '2026-04-25T00:00:00Z' },
      { type: 'ack', requestId: 'r1', ok: true },
      { type: 'ack', requestId: 'r1', ok: false, reason: 'not_ready' },
      { type: 'error', code: 'bad_request', message: 'x' },
      { type: 'snapshot', primaryAgent: null },
      {
        type: 'snapshot',
        primaryAgent: {
          id: 'p1',
          name: 'MTEAM',
          cliType: 'claude',
          systemPrompt: '',
          mcpConfig: [],
          status: 'RUNNING',
          sandbox: true,
          permissionMode: 'auto',
          createdAt: '2026-04-25T00:00:00Z',
          updatedAt: '2026-04-25T00:00:00Z',
        },
      },
    ];
    expect(samples).toHaveLength(8);
  });
});
