// S4-M3 joinCanvasNodes 单测：纯函数 join，免 DOM。
//
// 覆盖：
// - team=null / members 空 → 空数组
// - leader + members 去重 + 顺序：leader 先，members 其次，同 id 去重
// - roleInTeam 优先于 agent.name；均无回退到 instanceId
// - status 白名单外 → 'idle'；白名单内 → 原值
// - canvasStates 缺失 → layout.computeLayout 填默认位置（leader 位置非 0,0）
// - savedPositions 命中 → 使用保存值
// - messageCount/unreadCount 从 byInstance 桶统计

import { describe, test, expect } from 'bun:test';
import { joinCanvasNodes } from '../useCanvasNodes';
import type { TeamRow, TeamMemberRow } from '../../api/teams';
import type { Agent } from '../../store/agentStore';
import type { InstanceBucket, Message } from '../../types/chat';

function team(leader: string): TeamRow {
  return {
    id: 't1', name: 'Team', leaderInstanceId: leader, description: '',
    status: 'ACTIVE', createdAt: '', disbandedAt: null,
  };
}

function member(instanceId: string, roleInTeam: string | null = null): TeamMemberRow {
  return { id: 0, teamId: 't1', instanceId, roleInTeam, joinedAt: '' };
}

function msg(id: string, read?: boolean): Message {
  return { id, role: 'user', content: 'x', time: '00:00', read };
}

function bucket(...msgs: Message[]): InstanceBucket {
  return { messages: msgs, pendingPrompts: [] };
}

describe('joinCanvasNodes 基础', () => {
  test('team 为 null → 空数组', () => {
    expect(joinCanvasNodes({
      team: null, members: [], agents: [], byInstance: {}, savedPositions: {},
    })).toEqual([]);
  });

  test('只有 leader → 一个节点，isLeader=true', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [],
      agents: [{ id: 'L', name: 'Leader', status: 'idle' } as Agent],
      byInstance: {},
      savedPositions: {},
    });
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('L');
    expect(r[0].isLeader).toBe(true);
    expect(r[0].name).toBe('Leader');
    expect(r[0].status).toBe('idle');
  });

  test('leader 不在 agentPool → name fallback "Leader"', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [],
      agents: [],
      byInstance: {},
      savedPositions: {},
    });
    expect(r[0].name).toBe('Leader');
    expect(r[0].status).toBe('idle');
  });
});

describe('joinCanvasNodes 成员/去重/命名', () => {
  test('leader 出现在 members 里会被去重', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('L', 'leader-role'), member('M1')],
      agents: [],
      byInstance: {},
      savedPositions: {},
    });
    expect(r.length).toBe(2);
    expect(r.map((n) => n.id)).toEqual(['L', 'M1']);
    expect(r[0].isLeader).toBe(true);
  });

  test('name 优先级：roleInTeam > agent.name > instanceId', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('A', 'Ops'), member('B'), member('C')],
      agents: [
        { id: 'A', name: 'a-pool', status: 'idle' } as Agent,
        { id: 'B', name: 'b-pool', status: 'idle' } as Agent,
      ],
      byInstance: {},
      savedPositions: {},
    });
    const byId = Object.fromEntries(r.map((n) => [n.id, n.name]));
    expect(byId['A']).toBe('Ops');
    expect(byId['B']).toBe('b-pool');
    expect(byId['C']).toBe('C');
  });

  test('status 白名单外 fallback idle；白名单内保留', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('A'), member('B'), member('C')],
      agents: [
        { id: 'L', name: 'L', status: 'thinking' } as unknown as Agent,
        { id: 'A', name: 'A', status: 'responding' } as unknown as Agent,
        { id: 'B', name: 'B', status: 'offline' } as unknown as Agent,
        { id: 'C', name: 'C', status: 'running' } as unknown as Agent, // 非白名单
      ],
      byInstance: {},
      savedPositions: {},
    });
    const byId = Object.fromEntries(r.map((n) => [n.id, n.status]));
    expect(byId['L']).toBe('thinking');
    expect(byId['A']).toBe('responding');
    expect(byId['B']).toBe('offline');
    expect(byId['C']).toBe('idle');
  });
});

describe('joinCanvasNodes 位置布局', () => {
  test('无 savedPositions → computeLayout 给非零坐标', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('M1'), member('M2')],
      agents: [],
      byInstance: {},
      savedPositions: {},
    });
    // leader 位置由 leaderPos 计算，居中上方，x/y 均非 0
    expect(r[0].x).not.toBe(0);
    expect(r[0].y).not.toBe(0);
    // 成员在环上 —— 至少有一个成员 x 与 leader.x 不同
    const differ = r.slice(1).some((n) => n.x !== r[0].x);
    expect(differ).toBe(true);
  });

  test('savedPositions 命中 → 使用保存值', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('M1')],
      agents: [],
      byInstance: {},
      savedPositions: { L: { x: 11, y: 22 }, M1: { x: 33, y: 44 } },
    });
    const byId = Object.fromEntries(r.map((n) => [n.id, { x: n.x, y: n.y }]));
    expect(byId['L']).toEqual({ x: 11, y: 22 });
    expect(byId['M1']).toEqual({ x: 33, y: 44 });
  });
});

describe('joinCanvasNodes 消息统计', () => {
  test('messageCount = 桶内消息数；unreadCount = read !== true 的数', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [member('A')],
      agents: [],
      byInstance: {
        L: bucket(msg('1', true), msg('2', true), msg('3', false)),
        A: bucket(msg('x'), msg('y')),
      },
      savedPositions: {},
    });
    const byId = Object.fromEntries(r.map((n) => [n.id, n]));
    expect(byId['L'].messageCount).toBe(3);
    expect(byId['L'].unreadCount).toBe(1);
    expect(byId['A'].messageCount).toBe(2);
    expect(byId['A'].unreadCount).toBe(2); // 未传 read → 视为未读
  });

  test('无桶 → messageCount / unreadCount 为 0', () => {
    const r = joinCanvasNodes({
      team: team('L'),
      members: [],
      agents: [],
      byInstance: {},
      savedPositions: {},
    });
    expect(r[0].messageCount).toBe(0);
    expect(r[0].unreadCount).toBe(0);
    expect(r[0].taskCount).toBe(0);
  });
});
