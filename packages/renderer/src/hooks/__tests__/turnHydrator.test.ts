// turnHydrator 单测（S3-M1）。
//
// 核心验证点（TASK-LIST S3-M1）：
// - applyTurnsResponse(driverId, msg) 写入 byInstance[driverId] 桶
// - applyTurnHistoryResponse(driverId, msg) 同
// - 两个 driverId 各自 hydrate 不串桶
// - 去除 primary 隐式假设：primaryAgentStore.instanceId 为 null 也能按 driverId 写桶
//
// 边界 mock：只用真实 messageStore；不 mock 被测逻辑。

import { describe, test, expect, beforeEach } from 'bun:test';
import { applyTurnsResponse, applyTurnHistoryResponse } from '../turnHydrator';
import { useMessageStore } from '../../store/messageStore';
import { selectMessagesFor } from '../../store/messageStore.selectors';
import { usePrimaryAgentStore } from '../../store/primaryAgentStore';
import type { Turn } from '../../api/driver-turns';
import type { TurnsResponseMessage, TurnHistoryResponseMessage } from '../../api/ws-protocol';

function reset() {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
  usePrimaryAgentStore.setState({ instanceId: null });
}

function makeActiveTurn(driverId: string, turnId: string, text = 'hello'): Turn {
  return {
    turnId,
    driverId,
    status: 'active',
    userInput: { text: 'q', ts: '2026-04-28T00:00:00.000Z' },
    startTs: '2026-04-28T00:00:00.000Z',
    blocks: [{ type: 'text', blockId: 'b1', content: text }],
  };
}

function makeDoneTurn(driverId: string, turnId: string, text: string, endTs: string): Turn {
  return {
    turnId,
    driverId,
    status: 'done',
    userInput: { text: 'qq', ts: endTs },
    startTs: endTs,
    endTs,
    blocks: [{ type: 'text', blockId: `b-${turnId}`, content: text }],
  };
}

describe('applyTurnsResponse — per-instance 写桶', () => {
  beforeEach(reset);

  test('active turn driverId 匹配 → 写入对应桶', () => {
    const msg: TurnsResponseMessage = {
      type: 'get_turns_response',
      requestId: 'r1',
      active: makeActiveTurn('A', 't1', 'from-A'),
      recent: [],
    };
    applyTurnsResponse('A', msg);

    const msgsA = selectMessagesFor(useMessageStore.getState(), 'A');
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].turnId).toBe('t1');
    expect(msgsA[0].content).toBe('from-A');
    expect(msgsA[0].streaming).toBe(true);
    // 其它桶不受影响
    expect(selectMessagesFor(useMessageStore.getState(), 'B')).toHaveLength(0);
  });

  test('active.driverId 与参数不匹配 → 不写入（防穿桶）', () => {
    const msg: TurnsResponseMessage = {
      type: 'get_turns_response',
      requestId: 'r1',
      active: makeActiveTurn('other', 't1'),
      recent: [],
    };
    applyTurnsResponse('A', msg);
    expect(selectMessagesFor(useMessageStore.getState(), 'A')).toHaveLength(0);
  });

  test('recent 中已 streaming 的 turn 被强制收尾', () => {
    // 预置 A 桶里一条 streaming=true 的 turn t1
    useMessageStore.getState().addMessageFor('A', {
      id: 't1',
      role: 'agent',
      content: 'partial',
      time: '',
      turnId: 't1',
      streaming: true,
      blocks: [{ type: 'thinking', blockId: 'thk' }],
    });

    const msg: TurnsResponseMessage = {
      type: 'get_turns_response',
      requestId: 'r1',
      active: null,
      recent: [makeDoneTurn('A', 't1', 'done-text', '2026-04-28T00:01:00.000Z')],
    };
    applyTurnsResponse('A', msg);

    const after = selectMessagesFor(useMessageStore.getState(), 'A')[0];
    expect(after.streaming).toBe(false);
    expect(after.thinking).toBe(false);
    expect(after.blocks?.find((b) => b.type === 'thinking')).toBeUndefined();
  });

  test('两个 driverId 同时 hydrate 热快照 → 分桶不串', () => {
    applyTurnsResponse('A', {
      type: 'get_turns_response',
      requestId: 'r1',
      active: makeActiveTurn('A', 'ta', 'text-A'),
      recent: [],
    });
    applyTurnsResponse('B', {
      type: 'get_turns_response',
      requestId: 'r2',
      active: makeActiveTurn('B', 'tb', 'text-B'),
      recent: [],
    });

    const msgsA = selectMessagesFor(useMessageStore.getState(), 'A');
    const msgsB = selectMessagesFor(useMessageStore.getState(), 'B');
    expect(msgsA).toHaveLength(1);
    expect(msgsB).toHaveLength(1);
    expect(msgsA[0].turnId).toBe('ta');
    expect(msgsB[0].turnId).toBe('tb');
    expect(msgsA[0].content).toBe('text-A');
    expect(msgsB[0].content).toBe('text-B');
  });

  test('primary instanceId 为 null 时仍按 driverId 写桶（不依赖 primary）', () => {
    usePrimaryAgentStore.setState({ instanceId: null });
    applyTurnsResponse('X', {
      type: 'get_turns_response',
      requestId: 'r',
      active: makeActiveTurn('X', 'tx', 'text-X'),
      recent: [],
    });
    expect(selectMessagesFor(useMessageStore.getState(), 'X')).toHaveLength(1);
  });
});

describe('applyTurnHistoryResponse — per-instance 写桶', () => {
  beforeEach(reset);

  test('冷历史写入指定桶（按时间升序 + prepend）', () => {
    const msg: TurnHistoryResponseMessage = {
      type: 'get_turn_history_response',
      requestId: 'r1',
      // 后端按 endTs DESC 返回，t2 在前，t1 在后
      items: [
        makeDoneTurn('A', 't2', 'answer-2', '2026-04-28T00:02:00.000Z'),
        makeDoneTurn('A', 't1', 'answer-1', '2026-04-28T00:01:00.000Z'),
      ],
      hasMore: false,
      nextCursor: null,
    };
    applyTurnHistoryResponse('A', msg);

    const msgs = selectMessagesFor(useMessageStore.getState(), 'A');
    // 每个 turn 展开成 user + agent 两条 → 共 4 条
    expect(msgs).toHaveLength(4);
    // 升序：t1 的 user/agent 在前，t2 在后
    expect(msgs[0].id).toBe('u-t1');
    expect(msgs[1].id).toBe('t1');
    expect(msgs[2].id).toBe('u-t2');
    expect(msgs[3].id).toBe('t2');
    // 其它桶不受影响
    expect(selectMessagesFor(useMessageStore.getState(), 'B')).toHaveLength(0);
  });

  test('两个 driverId 冷历史并行 hydrate → 分桶不串', () => {
    applyTurnHistoryResponse('A', {
      type: 'get_turn_history_response',
      requestId: 'r1',
      items: [makeDoneTurn('A', 'ta1', 'a-text', '2026-04-28T00:01:00.000Z')],
      hasMore: false,
      nextCursor: null,
    });
    applyTurnHistoryResponse('B', {
      type: 'get_turn_history_response',
      requestId: 'r2',
      items: [makeDoneTurn('B', 'tb1', 'b-text', '2026-04-28T00:01:00.000Z')],
      hasMore: false,
      nextCursor: null,
    });

    const a = selectMessagesFor(useMessageStore.getState(), 'A');
    const b = selectMessagesFor(useMessageStore.getState(), 'B');
    expect(a.map((m) => m.id)).toEqual(['u-ta1', 'ta1']);
    expect(b.map((m) => m.id)).toEqual(['u-tb1', 'tb1']);
  });

  test('桶内已有同 turnId 的消息 → 跳过（不覆盖 active/streaming 态）', () => {
    // 预置 A 桶 streaming 态的 t1
    useMessageStore.getState().addMessageFor('A', {
      id: 't1',
      role: 'agent',
      content: 'partial',
      time: '',
      turnId: 't1',
      streaming: true,
    });

    applyTurnHistoryResponse('A', {
      type: 'get_turn_history_response',
      requestId: 'r1',
      items: [makeDoneTurn('A', 't1', 'should-not-overwrite', '2026-04-28T00:01:00.000Z')],
      hasMore: false,
      nextCursor: null,
    });

    const msgs = selectMessagesFor(useMessageStore.getState(), 'A');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].streaming).toBe(true);
    expect(msgs[0].content).toBe('partial');
  });

  test('items 为空 → no-op', () => {
    applyTurnHistoryResponse('A', {
      type: 'get_turn_history_response',
      requestId: 'r1',
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(selectMessagesFor(useMessageStore.getState(), 'A')).toHaveLength(0);
  });

  test('primary instanceId 为 null 时仍按 driverId 写桶', () => {
    usePrimaryAgentStore.setState({ instanceId: null });
    applyTurnHistoryResponse('Z', {
      type: 'get_turn_history_response',
      requestId: 'r',
      items: [makeDoneTurn('Z', 'tz', 'z-text', '2026-04-28T00:01:00.000Z')],
      hasMore: false,
      nextCursor: null,
    });
    expect(selectMessagesFor(useMessageStore.getState(), 'Z')).toHaveLength(2);
  });
});
