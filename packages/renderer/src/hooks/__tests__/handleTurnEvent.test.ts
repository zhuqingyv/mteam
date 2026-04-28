// handleTurnEvent 单测（S1-G1）。
//
// 核心验证点（TASK-LIST S1-G1）：
// - 去主 Agent 过滤后，任意 driverId 的 turn.* 事件都按 did 写入对应桶
// - 两个 driverId 交错事件 → 分桶正确（不互串）
// - 空 did 直接 return
// - turn.completed / turn.error 触发对应 iid 的 flushNextPending
//
// 边界 mock：只 mock WsClient（外部 IO）。messageStore 用真实 zustand 实例。

import { describe, test, expect, beforeEach } from 'bun:test';
import { handleTurnEvent } from '../handleTurnEvent';
import { useMessageStore } from '../../store/messageStore';
import { selectMessagesFor, selectPendingFor } from '../../store/messageStore.selectors';
import { useWsStore } from '../../store/wsStore';
import { usePrimaryAgentStore } from '../../store/primaryAgentStore';
import type { WsClient } from '../../api/ws';

type Call =
  | { op: 'prompt'; instanceId: string; text: string; requestId?: string }
  | { op: 'cancelTurn'; instanceId: string; requestId?: string };

function makeFakeClient(): { client: WsClient; calls: Call[] } {
  const calls: Call[] = [];
  const noop = () => {};
  const client: WsClient = {
    send: noop,
    subscribe: noop,
    unsubscribe: noop,
    prompt: (instanceId, text, requestId) => { calls.push({ op: 'prompt', instanceId, text, requestId }); },
    cancelTurn: (instanceId, requestId) => { calls.push({ op: 'cancelTurn', instanceId, requestId }); },
    configurePrimaryAgent: noop,
    getTurns: noop,
    getTurnHistory: noop,
    getWorkers: noop,
    ping: noop,
    close: noop,
    onEvent: noop,
    onAck: noop,
    onError: noop,
    onSnapshot: noop,
    onTurnsResponse: noop,
    onTurnHistoryResponse: noop,
    onWorkersResponse: noop,
    onReconnect: noop,
    readyState: () => 1,
  };
  return { client, calls };
}

function reset() {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
  usePrimaryAgentStore.setState({ instanceId: null });
  useWsStore.getState().setClient(null);
}

describe('handleTurnEvent — 空 did 防御', () => {
  beforeEach(reset);

  test('driverId 与 instanceId 都为空 → no-op', () => {
    handleTurnEvent('turn.started', { turnId: 't1' });
    expect(useMessageStore.getState().byInstance['']).toBeUndefined();
  });
});

describe('handleTurnEvent — turn.started 分桶', () => {
  beforeEach(reset);

  test('任意 driverId 都写入对应桶（不再过滤非 primary）', () => {
    usePrimaryAgentStore.setState({ instanceId: 'primary' });
    handleTurnEvent('turn.started', { driverId: 'other', turnId: 't1', ts: '10:00' });

    const msgs = selectMessagesFor(useMessageStore.getState(), 'other');
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe('t1');
    expect(msgs[0].turnId).toBe('t1');
    expect(msgs[0].streaming).toBe(true);
    // primary 桶不应被写入
    expect(selectMessagesFor(useMessageStore.getState(), 'primary')).toEqual([]);
  });

  test('替换 pending-* 占位气泡，保留在 did 桶', () => {
    useMessageStore.getState().addMessageFor('A', {
      id: 'pending-1', role: 'agent', content: '', time: '09:59', streaming: true, thinking: true,
    });
    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });

    const msgs = selectMessagesFor(useMessageStore.getState(), 'A');
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe('tA');
    expect(msgs[0].turnId).toBe('tA');
  });

  test('从 instanceId fallback 取 did', () => {
    handleTurnEvent('turn.started', { instanceId: 'B', turnId: 'tB', ts: '10:01' });
    expect(selectMessagesFor(useMessageStore.getState(), 'B').length).toBe(1);
  });
});

describe('handleTurnEvent — turn.block_updated 分桶', () => {
  beforeEach(reset);

  test('text block 覆盖扁平 content + 清 thinking（仅影响 did 桶）', () => {
    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });
    handleTurnEvent('turn.block_updated', {
      driverId: 'A',
      turnId: 'tA',
      ts: '10:01',
      block: { blockId: 'b1', type: 'text', content: 'hello' },
    });

    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'A');
    expect(aMsgs[0].content).toBe('hello');
    expect(aMsgs[0].thinking).toBe(false);
    expect(aMsgs[0].blocks?.length).toBe(1);
  });

  test('B 的 block_updated 不污染 A 桶', () => {
    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });
    handleTurnEvent('turn.started', { driverId: 'B', turnId: 'tB', ts: '10:00' });
    handleTurnEvent('turn.block_updated', {
      driverId: 'B', turnId: 'tB', ts: '10:01',
      block: { blockId: 'b1', type: 'text', content: 'for-B' },
    });

    expect(selectMessagesFor(useMessageStore.getState(), 'A')[0].content).toBe('');
    expect(selectMessagesFor(useMessageStore.getState(), 'B')[0].content).toBe('for-B');
  });
});

describe('handleTurnEvent — turn.completed 触发 flushNextPending(did)', () => {
  beforeEach(reset);

  test('A completed 只派 A 队首，B 队列不动', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    useMessageStore.getState().enqueuePromptFor('A', 'qA-1');
    useMessageStore.getState().enqueuePromptFor('B', 'qB-1');
    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });

    handleTurnEvent('turn.completed', { driverId: 'A', turnId: 'tA', ts: '10:02' });

    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'A');
    const completed = aMsgs.find((m) => m.id === 'tA');
    expect(completed?.streaming).toBe(false);

    // A 队首被派出：WS 只看到一条，instanceId=A
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'A', text: 'qA-1' });
    // B 队列没动
    expect(selectPendingFor(useMessageStore.getState(), 'B')).toEqual(['qB-1']);
  });
});

describe('handleTurnEvent — turn.error 分桶 + 不卡队列', () => {
  beforeEach(reset);

  test('已有 turn → 追加 [error]；并 flushNextPending(did)', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });
    useMessageStore.getState().enqueuePromptFor('A', 'qA-1');

    handleTurnEvent('turn.error', { driverId: 'A', turnId: 'tA', message: 'boom', ts: '10:03' });

    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'A');
    const errMsg = aMsgs.find((m) => m.id === 'tA');
    expect(errMsg?.content).toContain('[error] boom');
    expect(errMsg?.streaming).toBe(false);
    // 队首继续派
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'A', text: 'qA-1' });
  });

  test('未知 turn → 新建一条 [error] 消息到 did 桶', () => {
    handleTurnEvent('turn.error', { driverId: 'Z', turnId: 'tZ', message: 'oops', ts: '10:05' });
    const zMsgs = selectMessagesFor(useMessageStore.getState(), 'Z');
    expect(zMsgs.length).toBe(1);
    expect(zMsgs[0].content).toBe('[error] oops');
    expect(zMsgs[0].streaming).toBe(false);
  });
});

describe('handleTurnEvent — 两个 driverId 交错事件分桶正确', () => {
  beforeEach(reset);

  test('A/B 交错 started / block_updated / completed 互不串', () => {
    handleTurnEvent('turn.started', { driverId: 'A', turnId: 'tA', ts: '10:00' });
    handleTurnEvent('turn.started', { driverId: 'B', turnId: 'tB', ts: '10:00' });
    handleTurnEvent('turn.block_updated', {
      driverId: 'A', turnId: 'tA', ts: '10:01',
      block: { blockId: 'ba', type: 'text', content: 'A-text' },
    });
    handleTurnEvent('turn.block_updated', {
      driverId: 'B', turnId: 'tB', ts: '10:01',
      block: { blockId: 'bb', type: 'text', content: 'B-text' },
    });
    handleTurnEvent('turn.completed', { driverId: 'A', turnId: 'tA', ts: '10:02' });

    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'A');
    const bMsgs = selectMessagesFor(useMessageStore.getState(), 'B');

    expect(aMsgs.length).toBe(1);
    expect(aMsgs[0].content).toBe('A-text');
    expect(aMsgs[0].streaming).toBe(false);

    expect(bMsgs.length).toBe(1);
    expect(bMsgs[0].content).toBe('B-text');
    expect(bMsgs[0].streaming).toBe(true); // B 尚未 completed
  });
});
