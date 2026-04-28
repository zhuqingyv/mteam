// promptDispatcher 单测（S1-M2）。
//
// 核心验证点（契约 §4）：
// - 两个 iid 同时发送互不阻塞（A 正在 streaming 不应影响 B 立即派发）
// - cancel 只清对应 iid 队列（A cancel 不碰 B 的 pendingPrompts）
// - isTurnStreaming 按 iid 读对应桶
// - sendUserPrompt(text) 缺省 iid 时 fallback primary
// - sendUserPrompt 立即派发时 WS.prompt 参数 instanceId 正确
//
// 边界 mock：只 mock WsClient（外部 IO）。messageStore / primaryAgentStore 用真 zustand 实例。

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  sendUserPrompt,
  dispatchPromptNow,
  flushNextPending,
  cancelCurrentTurn,
  isTurnStreaming,
} from '../promptDispatcher';
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

function resetStores(primaryIid: string | null = null) {
  // 清 messageStore 桶
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
  // 设置 primary iid（用 setState 直接写，zustand 允许）
  usePrimaryAgentStore.setState({ instanceId: primaryIid });
}

describe('isTurnStreaming(iid)', () => {
  beforeEach(() => resetStores());

  test('空桶：false', () => {
    expect(isTurnStreaming('a')).toBe(false);
  });

  test('只有 pending-* 占位（无 turnId）：不算 streaming', () => {
    useMessageStore.getState().addMessageFor('a', {
      id: 'pending-1', role: 'agent', content: '', time: '10:00', streaming: true, thinking: true,
    });
    expect(isTurnStreaming('a')).toBe(false);
  });

  test('有 turnId + streaming=true 的 agent 消息：true', () => {
    useMessageStore.getState().addMessageFor('a', {
      id: 't1', role: 'agent', content: '', time: '10:00', streaming: true, turnId: 't1',
    });
    expect(isTurnStreaming('a')).toBe(true);
  });

  test('按 iid 隔离：A 桶 streaming 不影响 B 桶判定', () => {
    useMessageStore.getState().addMessageFor('a', {
      id: 't1', role: 'agent', content: '', time: '10:00', streaming: true, turnId: 't1',
    });
    expect(isTurnStreaming('a')).toBe(true);
    expect(isTurnStreaming('b')).toBe(false);
  });
});

describe('dispatchPromptNow(text, iid)', () => {
  beforeEach(() => resetStores());

  test('本地插入 pending 占位 + WS.prompt 发到正确 iid', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    dispatchPromptNow('hello', 'inst-A');

    const msgs = selectMessagesFor(useMessageStore.getState(), 'inst-A');
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('agent');
    expect(msgs[0].streaming).toBe(true);
    expect(msgs[0].thinking).toBe(true);
    expect(msgs[0].id.startsWith('pending-')).toBe(true);

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'inst-A', text: 'hello' });
    expect(calls[0].op === 'prompt' && calls[0].requestId?.startsWith('req-')).toBe(true);
  });

  test('iid 为空字符串：no-op（不插气泡，不发 WS）', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    dispatchPromptNow('hello', '');

    expect(calls.length).toBe(0);
    expect(useMessageStore.getState().byInstance['']).toBeUndefined();
  });
});

describe('sendUserPrompt(text, iid?)', () => {
  beforeEach(() => resetStores('primary-iid'));

  test('显式 iid + 无 streaming：user echo + 立即派发到该 iid', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    sendUserPrompt('hi', 'inst-A');

    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'inst-A');
    // 1 条 user echo + 1 条 pending agent 占位
    expect(aMsgs.length).toBe(2);
    expect(aMsgs[0].role).toBe('user');
    expect(aMsgs[0].content).toBe('hi');
    expect(aMsgs[1].role).toBe('agent');
    expect(aMsgs[1].streaming).toBe(true);

    expect(calls).toEqual([
      expect.objectContaining({ op: 'prompt', instanceId: 'inst-A', text: 'hi' }),
    ]);
  });

  test('省略 iid：fallback 到 primary instanceId', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    sendUserPrompt('yo');

    const pMsgs = selectMessagesFor(useMessageStore.getState(), 'primary-iid');
    expect(pMsgs.length).toBe(2);
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'primary-iid', text: 'yo' });
  });

  test('A 正在 streaming 时：新 prompt 入 A 队列，不触发 WS；B 不受影响', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    // 让 A 进入 streaming 状态
    useMessageStore.getState().addMessageFor('inst-A', {
      id: 't1', role: 'agent', content: '', time: '10:00', streaming: true, turnId: 't1',
    });

    sendUserPrompt('queued-1', 'inst-A');
    sendUserPrompt('queued-2', 'inst-A');

    // A 桶：只有 user echo 进了 messages；pendingPrompts 各 2 条；没发 WS
    const aPending = selectPendingFor(useMessageStore.getState(), 'inst-A');
    expect(aPending).toEqual(['queued-1', 'queued-2']);
    expect(calls.length).toBe(0);

    // B 桶立即派发不应被阻塞
    sendUserPrompt('to-B', 'inst-B');
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'inst-B', text: 'to-B' });

    // A 的 pending 没被 B 的行为影响
    expect(selectPendingFor(useMessageStore.getState(), 'inst-A')).toEqual(['queued-1', 'queued-2']);
    // B 桶没有 pending
    expect(selectPendingFor(useMessageStore.getState(), 'inst-B')).toEqual([]);
  });

  test('空串 / 纯空白：no-op', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);
    sendUserPrompt('', 'inst-A');
    sendUserPrompt('   ', 'inst-A');
    expect(calls.length).toBe(0);
    expect(useMessageStore.getState().byInstance['inst-A']).toBeUndefined();
  });

  test('primary iid 未设置 + 省略 iid：插错误提示消息走 deprecated 代理，primary=null → no-op', () => {
    resetStores(null);
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    sendUserPrompt('no iid');

    // deprecated addMessage 在 primary=null 时 warn + no-op，不抛错
    expect(calls.length).toBe(0);
  });
});

describe('flushNextPending(iid)', () => {
  beforeEach(() => resetStores());

  test('队列为空：no-op', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);
    flushNextPending('inst-A');
    expect(calls.length).toBe(0);
  });

  test('按 iid 取队首并 dispatchPromptNow 到该 iid', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    useMessageStore.getState().enqueuePromptFor('inst-A', 'q1');
    useMessageStore.getState().enqueuePromptFor('inst-A', 'q2');
    useMessageStore.getState().enqueuePromptFor('inst-B', 'qb');

    flushNextPending('inst-A');

    expect(selectPendingFor(useMessageStore.getState(), 'inst-A')).toEqual(['q2']);
    expect(selectPendingFor(useMessageStore.getState(), 'inst-B')).toEqual(['qb']); // 没动
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ op: 'prompt', instanceId: 'inst-A', text: 'q1' });
  });
});

describe('cancelCurrentTurn(iid?)', () => {
  beforeEach(() => resetStores('primary-iid'));

  test('只清对应 iid 队列；其它 iid 队列不动', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    useMessageStore.getState().enqueuePromptFor('inst-A', 'a1');
    useMessageStore.getState().enqueuePromptFor('inst-A', 'a2');
    useMessageStore.getState().enqueuePromptFor('inst-B', 'b1');

    cancelCurrentTurn('inst-A');

    expect(selectPendingFor(useMessageStore.getState(), 'inst-A')).toEqual([]);
    expect(selectPendingFor(useMessageStore.getState(), 'inst-B')).toEqual(['b1']);
    expect(calls).toEqual([
      expect.objectContaining({ op: 'cancelTurn', instanceId: 'inst-A' }),
    ]);
  });

  test('省略 iid：fallback primary，cancel primary 的队列', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    useMessageStore.getState().enqueuePromptFor('primary-iid', 'p1');
    useMessageStore.getState().enqueuePromptFor('inst-B', 'b1');

    cancelCurrentTurn();

    expect(selectPendingFor(useMessageStore.getState(), 'primary-iid')).toEqual([]);
    expect(selectPendingFor(useMessageStore.getState(), 'inst-B')).toEqual(['b1']);
    expect(calls[0]).toMatchObject({ op: 'cancelTurn', instanceId: 'primary-iid' });
  });

  test('client 为 null：no-op', () => {
    useWsStore.getState().setClient(null);
    useMessageStore.getState().enqueuePromptFor('inst-A', 'a1');
    cancelCurrentTurn('inst-A');
    // client=null 时整个函数早退，不清队列（契约 §4：`client` 为 null 时 no-op）
    expect(selectPendingFor(useMessageStore.getState(), 'inst-A')).toEqual(['a1']);
  });
});

describe('两个 iid 同时发送互不阻塞（契约 AC）', () => {
  beforeEach(() => resetStores('primary-iid'));

  test('A streaming 中，B 立即派发；A 队列累积，B WS 正常', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    // A 正在 streaming
    useMessageStore.getState().addMessageFor('A', {
      id: 'tA', role: 'agent', content: '', time: '10:00', streaming: true, turnId: 'tA',
    });

    sendUserPrompt('A-queue-1', 'A');
    sendUserPrompt('B-now', 'B');
    sendUserPrompt('A-queue-2', 'A');

    // A 累积 2 条 pending；B 直接派发
    expect(selectPendingFor(useMessageStore.getState(), 'A')).toEqual(['A-queue-1', 'A-queue-2']);
    expect(selectPendingFor(useMessageStore.getState(), 'B')).toEqual([]);

    const promptCalls = calls.filter((c) => c.op === 'prompt');
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0]).toMatchObject({ instanceId: 'B', text: 'B-now' });
  });

  test('A cancel 后 B 队列不变（契约 §4.2 + TASK-LIST S3-M2）', () => {
    const { client, calls } = makeFakeClient();
    useWsStore.getState().setClient(client);

    useMessageStore.getState().enqueuePromptFor('A', 'a1');
    useMessageStore.getState().enqueuePromptFor('A', 'a2');
    useMessageStore.getState().enqueuePromptFor('A', 'a3');
    useMessageStore.getState().enqueuePromptFor('B', 'b1');

    cancelCurrentTurn('A');

    expect(selectPendingFor(useMessageStore.getState(), 'A')).toEqual([]);
    expect(selectPendingFor(useMessageStore.getState(), 'B')).toEqual(['b1']);
    // cancel WS 只对 A
    const cancelCalls = calls.filter((c) => c.op === 'cancelTurn');
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]).toMatchObject({ instanceId: 'A' });
  });
});
