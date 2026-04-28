// S4-M1 instanceChatSelectors 单测。
// 覆盖：peer 列表组装（含自己不出现）、lastMessage/lastTime 汇总、消息按 peer 过滤、
//       历史无 peerId 的 turn 消息向后兼容归到 user。

import { describe, it, expect } from 'bun:test';
import { selectPeersFor, selectMessagesForPeer, type InstanceChatSelectorState } from '../instanceChat';
import type { Message, InstanceBucket } from '../../../types/chat';
import type { TeamMemberRow } from '../../../api/teams';
import type { Agent } from '../../agentStore';

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: 'agent', content: `c-${id}`, time: '00:00', ...over };
}

function bucket(messages: Message[] = [], pendingPrompts: string[] = []): InstanceBucket {
  return { messages, pendingPrompts };
}

function member(instanceId: string, roleInTeam: string | null = null): TeamMemberRow {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    teamId: 'T1',
    instanceId,
    roleInTeam,
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

function makeState(over: Partial<InstanceChatSelectorState> = {}): InstanceChatSelectorState {
  return {
    teamMembers: {},
    leaderInstanceId: null,
    agents: [],
    byInstance: {},
    ...over,
  };
}

describe('selectPeersFor', () => {
  it('总含 user，自己不出现在 peers 里', () => {
    const state = makeState({
      teamMembers: {
        T1: [member('I-self', 'Me'), member('I-A', 'A'), member('I-B', 'B')],
      },
    });
    const peers = selectPeersFor(state, 'I-self', 'T1', 'Alice');
    expect(peers[0]).toMatchObject({ id: 'user', name: 'Alice', role: 'user' });
    expect(peers.map((p) => p.id)).toEqual(['user', 'I-A', 'I-B']);
    expect(peers.every((p) => p.id !== 'I-self')).toBe(true);
  });

  it('leader 不在本节点时加 leader，role=leader；不重复加 member', () => {
    const state = makeState({
      leaderInstanceId: 'I-leader',
      leaderName: 'Cap',
      teamMembers: {
        T1: [member('I-leader'), member('I-member', 'Dev')],
      },
    });
    const peers = selectPeersFor(state, 'I-member', 'T1', 'Alice');
    // 自己（I-member）不出现；leader 出现一次 role=leader
    expect(peers.map((p) => p.id)).toEqual(['user', 'I-leader']);
    expect(peers.find((p) => p.id === 'I-leader')?.role).toBe('leader');
  });

  it('leader === instanceId 时不再在 peers 里重复自己', () => {
    const state = makeState({
      leaderInstanceId: 'I-leader',
      teamMembers: { T1: [member('I-leader'), member('I-A')] },
    });
    const peers = selectPeersFor(state, 'I-leader', 'T1', 'Alice');
    expect(peers.map((p) => p.id)).toEqual(['user', 'I-A']);
  });

  it('teamId=null 时只返回 user（没有 team 成员列表）', () => {
    const state = makeState();
    const peers = selectPeersFor(state, 'I-x', null, 'Alice');
    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe('user');
  });

  it('peer name 优先级：member.roleInTeam > agentStore.name > instanceId', () => {
    const state = makeState({
      agents: [{ id: 'I-A', name: 'AgentA' } as Agent, { id: 'I-B', name: 'AgentB' } as Agent],
      teamMembers: {
        T1: [member('I-A', 'Dev'), member('I-B', null), member('I-C', null)],
      },
    });
    const peers = selectPeersFor(state, 'I-self', 'T1', 'U');
    const byId: Record<string, string> = {};
    for (const p of peers) byId[p.id] = p.name;
    expect(byId['I-A']).toBe('Dev');         // roleInTeam 优先
    expect(byId['I-B']).toBe('AgentB');      // agentStore fallback
    expect(byId['I-C']).toBe('I-C');         // 裸 instanceId
  });

  it('lastMessage/lastTime 来自桶里最近一条匹配 peerId 的消息', () => {
    const state = makeState({
      teamMembers: { T1: [member('I-self'), member('I-other', 'Bob')] },
      byInstance: {
        'I-self': bucket([
          msg('m1', { peerId: 'user', content: 'hello user', time: '10:01' }),
          msg('m2', { peerId: 'I-other', content: 'hey Bob', time: '10:02' }),
          msg('m3', { peerId: 'user', content: 'more user', time: '10:03' }),
        ]),
      },
    });
    const peers = selectPeersFor(state, 'I-self', 'T1', 'Alice');
    const user = peers.find((p) => p.id === 'user');
    const bob = peers.find((p) => p.id === 'I-other');
    expect(user?.lastMessage).toBe('more user');
    expect(user?.lastTime).toBe('10:03');
    expect(bob?.lastMessage).toBe('hey Bob');
    expect(bob?.lastTime).toBe('10:02');
  });
});

describe('selectMessagesForPeer', () => {
  const base = makeState({
    byInstance: {
      'I-1': bucket([
        msg('u1', { peerId: 'user', content: 'hi' }),
        msg('u2', { peerId: 'user', content: 'hi2' }),
        msg('o1', { peerId: 'I-2', content: 'to I-2' }),
        msg('o2', { peerId: 'I-3', content: 'to I-3' }),
        // 历史遗留：无 peerId 的 turn 消息 —— fallback 归 user
        msg('legacy-turn', { kind: 'turn', content: 'old turn' }),
        // 历史遗留：无 kind 无 peerId —— 也视为 user（默认 turn 链路）
        msg('legacy-plain', { content: 'plain' }),
      ]),
      'I-2': bucket([msg('x1', { peerId: 'user', content: 'x1' })]),
    },
  });

  it('peer=user：匹配 peerId=user + 历史无 peerId 的 turn/裸消息', () => {
    const msgs = selectMessagesForPeer(base, 'I-1', 'user');
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'u2', 'legacy-turn', 'legacy-plain']);
  });

  it('peer=其它 instanceId：只匹配严格 peerId', () => {
    const msgs = selectMessagesForPeer(base, 'I-1', 'I-2');
    expect(msgs.map((m) => m.id)).toEqual(['o1']);
  });

  it('未知 iid 返回空数组', () => {
    expect(selectMessagesForPeer(base, 'missing', 'user')).toEqual([]);
  });

  it('跨桶隔离：I-2 桶不串 I-1 的消息', () => {
    const msgs = selectMessagesForPeer(base, 'I-2', 'user');
    expect(msgs.map((m) => m.id)).toEqual(['x1']);
  });
});
