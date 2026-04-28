// S4-M3 useCanvasNodes：team/agent/canvasStates/messageStore join 出 CanvasNodeData[]。
//
// 契约：INTERFACE-CONTRACTS §6.3 + §9。
// - 节点集合 = leader（primary agent） + activeTeam.members 去重
// - status/cliType 查 agentStore；name 优先 roleInTeam → agent.name → instanceId
// - x/y 取 canvasStates[teamId].nodePositions[iid]；缺失 → computeLayout 算
// - messageCount = selectMessagesFor(iid).length
// - unreadCount = 桶内 read !== true 的消息条数（跨 peer 求和，契约 §9）
// - taskCount：taskStore 目前非分桶，契约 §9 明确"store 缺则 0"，暂返 0
//
// 纯函数 joinCanvasNodes 抽出，便于 bun:test 免 DOM 直测。

import { useMemo } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useAgentStore, type Agent } from '../store/agentStore';
import { useMessageStore } from '../store/messageStore';
import { computeLayout, type CanvasSize } from '../organisms/TeamCanvas/layout';
import type { TeamRow, TeamMemberRow } from '../api/teams';
import type { CanvasNodeData, InstanceBucket, Message } from '../types/chat';

const DEFAULT_CANVAS: CanvasSize = { width: 960, height: 560 };
const STATUS_WHITELIST: ReadonlySet<CanvasNodeData['status']> = new Set([
  'idle', 'thinking', 'responding', 'offline',
]);

function normalizeStatus(raw: string | undefined): CanvasNodeData['status'] {
  if (raw && STATUS_WHITELIST.has(raw as CanvasNodeData['status'])) {
    return raw as CanvasNodeData['status'];
  }
  return 'idle';
}

function countUnread(msgs: Message[]): number {
  let n = 0;
  for (const m of msgs) if (m.read !== true) n += 1;
  return n;
}

function messagesOf(byInstance: Record<string, InstanceBucket>, iid: string): Message[] {
  return byInstance[iid]?.messages ?? [];
}

export interface JoinArgs {
  team: TeamRow | null;
  members: TeamMemberRow[];
  agents: Agent[];
  byInstance: Record<string, InstanceBucket>;
  savedPositions: Record<string, { x: number; y: number }>;
  canvasSize?: CanvasSize;
}

// 纯 join：给定 team/members/agents/messageState/savedPositions → CanvasNodeData[]。
export function joinCanvasNodes(args: JoinArgs): CanvasNodeData[] {
  const { team, members, agents, byInstance, savedPositions } = args;
  if (!team) return [];
  const size = args.canvasSize ?? DEFAULT_CANVAS;
  const leaderId = team.leaderInstanceId;

  const seen = new Set<string>();
  const ordered: { id: string; name: string; isLeader: boolean; cliType?: string; status: CanvasNodeData['status'] }[] = [];

  if (leaderId) {
    const pool = agents.find((a) => a.id === leaderId);
    ordered.push({
      id: leaderId,
      name: pool?.name ?? 'Leader',
      isLeader: true,
      cliType: pool?.icon,
      status: normalizeStatus(pool?.status),
    });
    seen.add(leaderId);
  }

  for (const m of members) {
    if (seen.has(m.instanceId)) continue;
    seen.add(m.instanceId);
    const pool = agents.find((a) => a.id === m.instanceId);
    ordered.push({
      id: m.instanceId,
      name: m.roleInTeam ?? pool?.name ?? m.instanceId,
      isLeader: false,
      cliType: pool?.icon,
      status: normalizeStatus(pool?.status),
    });
  }

  const positions = computeLayout(
    ordered.map((c) => ({ id: c.id, isLeader: c.isLeader })),
    size,
    savedPositions,
  );

  return ordered.map((c) => {
    const msgs = messagesOf(byInstance, c.id);
    const pos = positions[c.id] ?? { x: 0, y: 0 };
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      cliType: c.cliType,
      isLeader: c.isLeader,
      x: pos.x,
      y: pos.y,
      taskCount: 0,
      unreadCount: countUnread(msgs),
      messageCount: msgs.length,
    };
  });
}

export function useCanvasNodes(teamId: string | null): CanvasNodeData[] {
  const teams = useTeamStore((s) => s.teams);
  const membersMap = useTeamStore((s) => s.teamMembers);
  const canvasStates = useTeamStore((s) => s.canvasStates);
  const agents = useAgentStore((s) => s.agents);
  const byInstance = useMessageStore((s) => s.byInstance);

  return useMemo(() => {
    if (!teamId) return [];
    const team = teams.find((t) => t.id === teamId) ?? null;
    const members = membersMap[teamId] ?? [];
    const savedPositions = canvasStates[teamId]?.nodePositions ?? {};
    return joinCanvasNodes({ team, members, agents, byInstance, savedPositions });
  }, [teamId, teams, membersMap, canvasStates, agents, byInstance]);
}
