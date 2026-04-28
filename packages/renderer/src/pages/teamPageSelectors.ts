import type { TeamMemberRow } from '../api/teams';
import type { Agent } from '../store/agentStore';
import { useMessageStore } from '../store/messageStore';
import { selectUnreadMap } from '../store/selectors/unread';
import type { CanvasNodeData, InstanceBucket } from '../types/chat';

// Agent.status → CanvasNodeData.status（UI 四态）；running 默认映到 idle。
const STATUS_MAP: Record<string, CanvasNodeData['status']> = {
  offline: 'offline', thinking: 'thinking', responding: 'responding',
};
export function mapStatus(raw: string | undefined): CanvasNodeData['status'] {
  return STATUS_MAP[raw ?? ''] ?? 'idle';
}

interface BuildArgs {
  leaderId: string | undefined;
  members: TeamMemberRow[];
  agentPool: Agent[];
  byInstance: Record<string, InstanceBucket>;
  layoutFn: (cards: { id: string; isLeader: boolean }[]) => Record<string, { x: number; y: number }>;
}

// 从 store 派生 CanvasNodeData[]：leader 排第一、成员随后（不重复 leader）。
export function buildTeamAgents({ leaderId, members, agentPool, byInstance, layoutFn }: BuildArgs): CanvasNodeData[] {
  const cards: { id: string; name: string; status: string; cliType?: string; isLeader: boolean }[] = [];
  if (leaderId) {
    const pool = agentPool.find((a) => a.id === leaderId);
    cards.push({ id: leaderId, name: pool?.name ?? 'Leader', status: pool?.status ?? 'idle', isLeader: true });
  }
  for (const m of members) {
    if (m.instanceId === leaderId) continue;
    const pool = agentPool.find((a) => a.id === m.instanceId);
    cards.push({
      id: m.instanceId,
      name: m.roleInTeam ?? pool?.name ?? m.instanceId,
      status: pool?.status ?? 'idle',
      isLeader: false,
    });
  }
  const positions = layoutFn(cards.map((c) => ({ id: c.id, isLeader: c.isLeader })));
  return cards.map((c) => {
    const p = positions[c.id] ?? { x: 0, y: 0 };
    const bucket = byInstance[c.id];
    // unread: selectUnreadMap 内部自取 store snapshot；传 state 保持纯函数语义。
    const unreadMap = selectUnreadMap(useMessageStore.getState(), c.id);
    return {
      id: c.id,
      name: c.name,
      status: mapStatus(c.status),
      cliType: c.cliType,
      isLeader: c.isLeader,
      x: p.x,
      y: p.y,
      taskCount: 0,
      unreadCount: Object.values(unreadMap).reduce((a, n) => a + n, 0),
      messageCount: bucket?.messages.length ?? 0,
    };
  });
}
