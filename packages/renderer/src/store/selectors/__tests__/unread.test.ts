// S4-M2 unreadSelectors 单测。
// 覆盖：selectUnreadFor 严格按 peerId + read 统计；
//      markPeerRead 后 selector 归零；
//      selectUnreadMap 汇总 + 忽略无 peerId 的消息；
//      跨桶独立。

import { describe, it, expect, beforeEach } from 'bun:test';
import { selectUnreadFor, selectUnreadMap } from '../unread';
import { useMessageStore, type MessageState } from '../../messageStore';
import type { Message } from '../../../types/chat';
import { usePrimaryAgentStore } from '../../primaryAgentStore';

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: 'agent', content: `c-${id}`, time: '00:00', ...over };
}

function reset() {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
  usePrimaryAgentStore.setState({ instanceId: null });
}

function getState(): MessageState {
  return useMessageStore.getState();
}

describe('selectUnreadFor', () => {
  beforeEach(() => reset());

  it('统计桶内 peerId 匹配且 read !== true 的消息数', () => {
    const s = getState();
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    s.addMessageFor('A', msg('u2', { peerId: 'user', read: false }));
    s.addMessageFor('A', msg('u3', { peerId: 'user', read: true }));
    s.addMessageFor('A', msg('o1', { peerId: 'I-2' }));

    expect(selectUnreadFor(getState(), 'A', 'user')).toBe(2);
    expect(selectUnreadFor(getState(), 'A', 'I-2')).toBe(1);
  });

  it('markPeerRead 之后归零', () => {
    const s = getState();
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    s.addMessageFor('A', msg('u2', { peerId: 'user' }));
    expect(selectUnreadFor(getState(), 'A', 'user')).toBe(2);

    getState().markPeerRead('A', 'user');
    expect(selectUnreadFor(getState(), 'A', 'user')).toBe(0);
  });

  it('markPeerRead 不串到其它 peer', () => {
    const s = getState();
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    s.addMessageFor('A', msg('o1', { peerId: 'I-2' }));
    s.markPeerRead('A', 'user');

    expect(selectUnreadFor(getState(), 'A', 'user')).toBe(0);
    expect(selectUnreadFor(getState(), 'A', 'I-2')).toBe(1);
  });

  it('未知 iid 返回 0', () => {
    expect(selectUnreadFor(getState(), 'missing', 'user')).toBe(0);
  });

  it('无 peerId 的消息不会被计入任何 peer 的未读', () => {
    const s = getState();
    s.addMessageFor('A', msg('legacy', { kind: 'turn' })); // 无 peerId
    expect(selectUnreadFor(getState(), 'A', 'user')).toBe(0);
  });
});

describe('selectUnreadMap', () => {
  beforeEach(() => reset());

  it('汇总所有 peer 未读计数', () => {
    const s = getState();
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    s.addMessageFor('A', msg('u2', { peerId: 'user' }));
    s.addMessageFor('A', msg('o1', { peerId: 'I-2' }));
    s.addMessageFor('A', msg('o2', { peerId: 'I-3', read: true })); // 已读不算

    expect(selectUnreadMap(getState(), 'A')).toEqual({ user: 2, 'I-2': 1 });
  });

  it('无 peerId 的消息不纳入 map', () => {
    const s = getState();
    s.addMessageFor('A', msg('legacy', { kind: 'turn' }));
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    expect(selectUnreadMap(getState(), 'A')).toEqual({ user: 1 });
  });

  it('跨桶独立：A 桶未读不影响 B 桶', () => {
    const s = getState();
    s.addMessageFor('A', msg('u1', { peerId: 'user' }));
    s.addMessageFor('B', msg('u1', { peerId: 'user' }));
    s.addMessageFor('B', msg('u2', { peerId: 'user' }));

    expect(selectUnreadMap(getState(), 'A')).toEqual({ user: 1 });
    expect(selectUnreadMap(getState(), 'B')).toEqual({ user: 2 });
  });

  it('未知 iid 返回空对象', () => {
    expect(selectUnreadMap(getState(), 'missing')).toEqual({});
  });
});
