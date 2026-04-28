// S4-G2a：CanvasNodeChatBody 装配行为 — selector 驱动 + markPeerRead 联动。
//
// 无 DOM 测试栈：这里测"纯选择器 + store.markPeerRead"的联动语义，
// 保证切 peer 时会把桶里该 peer 的历史消息标 read。组件 JSX 本身是薄壳，
// ChatList 的 onSelect 回调里只做 setActivePeerId + markPeerRead，逻辑等价直测。

import { describe, test, expect, beforeEach } from 'bun:test';
import { useMessageStore } from '../../../store/messageStore';
import {
  selectPeersFor,
  selectMessagesForPeer,
  type InstanceChatSelectorState,
} from '../../../store/selectors/instanceChat';

function reset(): void {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
}

describe('CanvasNodeChatBody · selectPeersFor 联动', () => {
  beforeEach(reset);

  test('peers 列表至少含 user；leader 非自己时含 leader；自身不出现', () => {
    useMessageStore.setState({
      byInstance: { 'inst-A': { messages: [], pendingPrompts: [] } },
      messages: [],
      pendingPrompts: [],
    });
    const state: InstanceChatSelectorState = {
      byInstance: useMessageStore.getState().byInstance,
      teamMembers: { 't1': [{ id: 1, teamId: 't1', instanceId: 'inst-A', roleInTeam: null, joinedAt: '' }] },
      agents: [{ id: 'inst-A', name: 'A', status: 'idle' }, { id: 'leader', name: 'Leader', status: 'idle' }],
      leaderInstanceId: 'leader',
    };
    const peers = selectPeersFor(state, 'inst-A', 't1', 'You');
    expect(peers.map((p) => p.id)).toEqual(['user', 'leader']);
  });

  test('展开的是 leader 自己 → peers 不含 leader（避免自聊）', () => {
    const state: InstanceChatSelectorState = {
      byInstance: {},
      teamMembers: { 't1': [] },
      agents: [{ id: 'leader', name: 'Leader', status: 'idle' }],
      leaderInstanceId: 'leader',
    };
    const peers = selectPeersFor(state, 'leader', 't1', 'You');
    expect(peers.map((p) => p.id)).toEqual(['user']);
  });
});

describe('CanvasNodeChatBody · markPeerRead 效果（切换 peer 清未读）', () => {
  beforeEach(reset);

  test('markPeerRead 后 selectMessagesForPeer 该 peer 所有消息 read=true', () => {
    useMessageStore.setState({
      byInstance: {
        A: {
          messages: [
            { id: 'u1', role: 'user', content: 'hi', time: '10:00', peerId: 'user', read: false },
            { id: 'b1', role: 'agent', content: 'from B', time: '10:01', peerId: 'B', kind: 'comm-in', read: false },
          ],
          pendingPrompts: [],
        },
      },
      messages: [],
      pendingPrompts: [],
    });
    useMessageStore.getState().markPeerRead('A', 'user');
    const msgs = selectMessagesForPeer(useMessageStore.getState(), 'A', 'user');
    expect(msgs.every((m) => m.read === true)).toBe(true);
    const bMsgs = selectMessagesForPeer(useMessageStore.getState(), 'A', 'B');
    expect(bMsgs[0].read).toBe(false); // 其它 peer 未受影响
  });
});
