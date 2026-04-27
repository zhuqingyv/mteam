import { useAgentStore, useNotificationStore, usePrimaryAgentStore, useTeamStore, primaryAgentBridge } from '../store';
import type { AgentState, PrimaryAgentRow } from '../api/primaryAgent';
import type { TeamRow, TeamMemberRow } from '../api/teams';

export { handleTurnEvent } from './handleTurnEvent';

const AGENT_STATES: ReadonlySet<string> = new Set(['idle', 'thinking', 'responding']);

const eid = (e: Record<string, unknown>) => {
  const p = e.payload as Record<string, unknown> | undefined;
  return String(p?.instanceId ?? p?.id ?? e.instanceId ?? '');
};

export function handlePrimaryAgentEvent(t: string, e: Record<string, unknown>) {
  if (t === 'primary_agent.started') {
    // 重新 start（含切 CLI 后重启）→ 回到 idle 态。
    usePrimaryAgentStore.setState({ status: 'RUNNING', agentState: 'idle', lastError: null });
    return;
  }
  if (t === 'primary_agent.stopped') {
    usePrimaryAgentStore.setState({ status: 'STOPPED', agentState: 'idle' });
    return;
  }
  if (t === 'primary_agent.configured') {
    const row = e.row as PrimaryAgentRow | undefined;
    if (row) {
      usePrimaryAgentStore.setState({
        config: row,
        instanceId: row.id,
        status: row.status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
        agentState: row.agentState ?? 'idle',
        lastError: null,
      });
    }
    return;
  }
  if (t === 'primary_agent.state_changed') {
    const raw = String(e.agentState ?? '');
    if (AGENT_STATES.has(raw)) {
      usePrimaryAgentStore.setState({ agentState: raw as AgentState });
    }
    return;
  }
}

export function handleDriverEvent(t: string, e: Record<string, unknown>) {
  const driverId = String(e.driverId ?? e.instanceId ?? '');
  primaryAgentBridge.onDriverEvent(t, driverId);
}

export function handleInstanceEvent(t: string, e: Record<string, unknown>) {
  const as = useAgentStore.getState;
  if (t === 'instance.created') {
    const id = eid(e), p = e.payload as Record<string, unknown> | undefined;
    // WS 下行是平铺的（见 toWsPayload），payload 字段可能不存在 —— 先读 payload、再兜底平铺。
    const name = String(p?.memberName ?? p?.roleName ?? e.memberName ?? e.roleName ?? 'Agent');
    if (id) as().setAgents([...as().agents, { id, name, status: 'idle' }]);
  } else if (t === 'instance.deleted') {
    const id = eid(e);
    if (id) as().setAgents(as().agents.filter((a) => a.id !== id));
  } else if (t === 'instance.activated') {
    const id = eid(e);
    if (id) { as().setActiveAgent(id); as().setAgents(as().agents.map((a) => a.id === id ? { ...a, status: 'running' } : a)); }
  } else if (t === 'instance.offline_requested') {
    const id = eid(e);
    if (id) as().setAgents(as().agents.map((a) => a.id === id ? { ...a, status: 'offline' } : a));
  }
}

export function handleTeamEvent(t: string, e: Record<string, unknown>) {
  const ts = useTeamStore.getState();
  if (t === 'team.created') {
    // WS 下行是平铺字段（teamId/name/leaderInstanceId），要映射到 TeamRow（id/...）。
    const p = (e.payload ?? e) as Record<string, unknown>;
    const id = String(p.teamId ?? p.id ?? '');
    if (!id) return;
    const team: TeamRow = {
      id,
      name: String(p.name ?? ''),
      leaderInstanceId: String(p.leaderInstanceId ?? ''),
      description: String(p.description ?? ''),
      status: 'ACTIVE',
      createdAt: String(p.ts ?? e.ts ?? new Date().toISOString()),
      disbandedAt: null,
    };
    ts.addTeam(team);
    ts.setActiveTeam(id);
    window.electronAPI?.openTeamPanel();
  } else if (t === 'team.disbanded') {
    const id = String((e.payload as Record<string, unknown>)?.id ?? e.teamId ?? '');
    if (id) ts.removeTeam(id);
  } else if (t === 'team.member_joined') {
    const p = (e.payload ?? e) as Record<string, unknown>;
    const teamId = String(p.teamId ?? '');
    const instanceId = String(p.instanceId ?? '');
    if (teamId && instanceId) {
      const roleInTeam = p.roleInTeam == null ? null : String(p.roleInTeam);
      const joinedAt = String(p.ts ?? e.ts ?? new Date().toISOString());
      const row: TeamMemberRow = { id: 0, teamId, instanceId, roleInTeam, joinedAt };
      ts.addTeamMember(teamId, row);
    }
  } else if (t === 'team.member_left') {
    const p = (e.payload ?? e) as Record<string, unknown>;
    const teamId = String(p.teamId ?? '');
    const instanceId = String(p.instanceId ?? '');
    if (teamId && instanceId) ts.removeTeamMember(teamId, instanceId);
  }
}

export function handleOtherEvent(t: string, e: Record<string, unknown>) {
  if (t === 'notification.delivered') {
    useNotificationStore.getState().push({
      id: String(e.eventId ?? e.sourceEventId ?? Date.now()),
      title: String(e.sourceEventType ?? 'notification'), message: '', time: String(e.ts ?? ''),
    });
  }
  // comm.message_sent/received 不在这里插消息：
  // - 用户消息由 ExpandedView.handleSend 本地直接 addMessage；
  // - agent 回复由 turn.block_updated 累积成内容完整的消息，再插空壳会显示成空气泡。
}
