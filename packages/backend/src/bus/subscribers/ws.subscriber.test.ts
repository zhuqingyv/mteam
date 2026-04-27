// W2-H 守门测试：bus 契约冻结 + WS 白名单不漂移。
// v2 修订：phase-comm 明确不新增 comm.message_delivered 事件（见 TASK-LIST §523-526）。
// 这两条断言失败 = 有人偷改契约，CI 会立刻捕获。
import { describe, it, expect } from 'bun:test';
import { WS_EVENT_TYPES } from './ws.subscriber.js';
import type { BusEvent, BusEventType } from '../types.js';

describe('W2-H · bus 契约冻结', () => {
  it('WS_EVENT_TYPES 集合尺寸 = 40（Phase 4 新增 5 条 action_item.*：35 → 40）', () => {
    // 漂移要么是新增事件该走 PR review，要么是误删，两种都要被捕获。
    expect(WS_EVENT_TYPES.size).toBe(40);
  });

  it('WS 白名单包含 comm.message_sent / comm.message_received', () => {
    expect(WS_EVENT_TYPES.has('comm.message_sent')).toBe(true);
    expect(WS_EVENT_TYPES.has('comm.message_received')).toBe(true);
  });

  it('WS 白名单不含 comm.message_delivered（v2 明确拒绝扩 payload）', () => {
    // 通过 string 强转绕过 TS 字面量检查：即便未来 BusEventType 被偷偷加回来，
    // 运行时断言仍会抓到。
    expect(WS_EVENT_TYPES.has('comm.message_delivered' as BusEventType)).toBe(false);
  });

  it('WS 白名单保留 driver 生命周期三件：started / stopped / error（前端渲染 agent 在线/离线/出错）', () => {
    expect(WS_EVENT_TYPES.has('driver.started')).toBe(true);
    expect(WS_EVENT_TYPES.has('driver.stopped')).toBe(true);
    expect(WS_EVENT_TYPES.has('driver.error')).toBe(true);
  });

  it('WS 白名单不含 driver 细粒度 5 件（由 turn.* 聚合替代）', () => {
    // T-11：driver.thinking/text/tool_call/tool_result/turn_done 不再直推前端。
    // 用 as BusEventType 绕过类型收窄，保证即使未来有人把字面量加回 union，
    // 运行时断言仍会抓到。
    for (const t of [
      'driver.thinking',
      'driver.text',
      'driver.tool_call',
      'driver.tool_result',
      'driver.turn_done',
    ] as const) {
      expect(WS_EVENT_TYPES.has(t as BusEventType)).toBe(false);
    }
  });

  it('WS 白名单包含 turn.* 四件（聚合后前端唯一来源）', () => {
    expect(WS_EVENT_TYPES.has('turn.started')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.block_updated')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.completed')).toBe(true);
    expect(WS_EVENT_TYPES.has('turn.error')).toBe(true);
  });

  it('comm.message_sent payload 字段冻结为 {messageId, from, to}', () => {
    // 构造一个完整事件，确保 required 字段固定；多字段/少字段都会 TS 失败。
    const e: BusEvent = {
      type: 'comm.message_sent',
      ts: 't',
      source: 'test',
      messageId: 'msg_x',
      from: 'a',
      to: 'b',
    };
    expect(e.type).toBe('comm.message_sent');
  });

  it('comm.message_received payload 字段冻结为 {messageId, from, to, route}', () => {
    const e: BusEvent = {
      type: 'comm.message_received',
      ts: 't',
      source: 'test',
      messageId: 'msg_x',
      from: 'a',
      to: 'b',
      route: 'online',
    };
    expect(e.type).toBe('comm.message_received');
  });
});
