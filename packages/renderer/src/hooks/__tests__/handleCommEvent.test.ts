// handleCommEvent 单测（S4-G2b）。
//
// 验证点（TASK-LIST S4-G2b AC）：
// - comm.message_sent A→B → byInstance[A] 和 byInstance[B] 各得一条
// - 同 msgId 重复推送 → 各桶仍只有一条
// - 只订了 A 的 instance（没有 B 桶）也能通过 B 桶拿到自己收到的消息（桶自动创建）
// - extractPeerId 口径：user→'user'，agent→ instanceId，否则从 address 解析
//
// 无 DOM / 无 WsClient mock，直接跑纯函数 + 真实 zustand 消息桶。

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  extractPeerId,
  eventToCommRecord,
  handleCommEvent,
  type CommEnvelope,
} from '../handleCommEvent';
import { useMessageStore } from '../../store/messageStore';
import { selectMessagesFor } from '../../store/messageStore.selectors';

function reset(): void {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
}

describe('extractPeerId', () => {
  test('user kind 一律归到 "user"', () => {
    expect(extractPeerId({ kind: 'user', address: 'user:u1', instanceId: null })).toBe('user');
  });
  test('agent 优先 instanceId', () => {
    expect(extractPeerId({ kind: 'agent', instanceId: 'inst-A', address: 'local:inst-A' })).toBe('inst-A');
  });
  test('agent 无 instanceId 时从 address 解析', () => {
    expect(extractPeerId({ kind: 'agent', address: 'local:inst-B' })).toBe('inst-B');
  });
  test('无 actor / 无 address 返回 null', () => {
    expect(extractPeerId(undefined)).toBe(null);
    expect(extractPeerId({ kind: 'agent' })).toBe(null);
  });
});

describe('eventToCommRecord', () => {
  test('A→B：outbound 写 A 桶 comm-out peerId=B；inbound 写 B 桶 comm-in peerId=A', () => {
    const env: CommEnvelope = {
      id: 'm1',
      from: { kind: 'agent', instanceId: 'A' },
      to: { kind: 'agent', instanceId: 'B' },
      content: 'hi',
      ts: '2026-04-28T10:00:00.000Z',
    };
    const r = eventToCommRecord(env);
    expect(r.fromId).toBe('A');
    expect(r.toId).toBe('B');
    expect(r.outbound?.kind).toBe('comm-out');
    expect(r.outbound?.peerId).toBe('B');
    expect(r.inbound?.kind).toBe('comm-in');
    expect(r.inbound?.peerId).toBe('A');
  });

  test('user→A：只产生 inbound（user 没有桶）', () => {
    const env: CommEnvelope = {
      id: 'm2',
      from: { kind: 'user', address: 'user:u1' },
      to: { kind: 'agent', instanceId: 'A' },
      content: 'from user',
    };
    const r = eventToCommRecord(env);
    expect(r.fromId).toBe(null);
    expect(r.outbound).toBe(null);
    expect(r.toId).toBe('A');
    expect(r.inbound?.peerId).toBe('user');
  });
});

describe('handleCommEvent — 双桶写入', () => {
  beforeEach(reset);

  test('A→B 同一事件 → A 桶与 B 桶各有一条', () => {
    handleCommEvent('comm.message_sent', {
      envelope: {
        id: 'msg-1',
        from: { kind: 'agent', instanceId: 'A' },
        to: { kind: 'agent', instanceId: 'B' },
        content: 'hello',
      },
    });
    const aMsgs = selectMessagesFor(useMessageStore.getState(), 'A');
    const bMsgs = selectMessagesFor(useMessageStore.getState(), 'B');
    expect(aMsgs).toHaveLength(1);
    expect(bMsgs).toHaveLength(1);
    expect(aMsgs[0].kind).toBe('comm-out');
    expect(aMsgs[0].peerId).toBe('B');
    expect(bMsgs[0].kind).toBe('comm-in');
    expect(bMsgs[0].peerId).toBe('A');
  });

  test('同 msgId 重复推送 → 各桶仍只有一条（按 bucket 独立去重）', () => {
    const env: CommEnvelope = {
      id: 'msg-dup',
      from: { kind: 'agent', instanceId: 'A' },
      to: { kind: 'agent', instanceId: 'B' },
      content: 'x',
    };
    handleCommEvent('comm.message_sent', { envelope: env });
    handleCommEvent('comm.message_sent', { envelope: env });
    expect(selectMessagesFor(useMessageStore.getState(), 'A')).toHaveLength(1);
    expect(selectMessagesFor(useMessageStore.getState(), 'B')).toHaveLength(1);
  });

  test('只订了 A 的场景：B 桶不存在 → handler 自动创建 B 桶并写入', () => {
    // 初始只有 A 桶（模拟"订阅了 A"）
    useMessageStore.setState({
      byInstance: { A: { messages: [], pendingPrompts: [] } },
      messages: [],
      pendingPrompts: [],
    });
    handleCommEvent('comm.message_received', {
      envelope: {
        id: 'msg-only-A',
        from: { kind: 'agent', instanceId: 'A' },
        to: { kind: 'agent', instanceId: 'B' },
        content: 'auto-bucket',
      },
    });
    const bMsgs = selectMessagesFor(useMessageStore.getState(), 'B');
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0].content).toBe('auto-bucket');
  });

  test('envelope 平铺在事件顶层（非 payload 包裹）也能解析', () => {
    handleCommEvent('comm.message_sent', {
      id: 'flat',
      from: { kind: 'agent', instanceId: 'A' },
      to: { kind: 'agent', instanceId: 'B' },
      content: 'flat-top',
    });
    expect(selectMessagesFor(useMessageStore.getState(), 'A')).toHaveLength(1);
    expect(selectMessagesFor(useMessageStore.getState(), 'B')).toHaveLength(1);
  });
});
