import { getPrimaryAgent } from '../api/primaryAgent';
import { listInstances } from '../api/instances';
import { useMessageStore, useAgentStore, useNotificationStore, usePrimaryAgentStore, useTeamStore } from '../store';
import type { TeamRow } from '../api/teams';

const eid = (e: Record<string, unknown>) => {
  const p = e.payload as Record<string, unknown> | undefined;
  return String(p?.instanceId ?? p?.id ?? e.instanceId ?? '');
};

export function handlePrimaryAgentEvent(t: string, _e: Record<string, unknown>) {
  const pa = usePrimaryAgentStore.getState();
  if (t === 'primary_agent.started') {
    pa.setStatus('RUNNING');
    listInstances().then((r) => {
      if (!r.ok || !r.data) return;
      const leader = r.data.find((i) => i.isLeader);
      if (leader) pa.setInstanceId(leader.id);
    }).catch(() => {});
  } else if (t === 'primary_agent.stopped') {
    pa.setStatus('STOPPED');
  } else if (t === 'primary_agent.configured') {
    getPrimaryAgent().then((r) => { if (r.ok && r.data) pa.setConfig(r.data); }).catch(() => {});
  }
}

export function handleDriverEvent(t: string, e: Record<string, unknown>) {
  const pa = usePrimaryAgentStore.getState();
  const did = String(e.driverId ?? e.instanceId ?? '');
  if (!pa.instanceId || did !== pa.instanceId) return;
  if (t === 'driver.started') pa.setDriverLifecycle('ready');
  else if (t === 'driver.stopped') pa.setDriverLifecycle('stopped');
  else if (t === 'driver.error') pa.setDriverLifecycle('error');
}

export function handleInstanceEvent(t: string, e: Record<string, unknown>) {
  const as = useAgentStore.getState;
  if (t === 'instance.created') {
    const id = eid(e), p = e.payload as Record<string, unknown> | undefined;
    if (id) as().setAgents([...as().agents, { id, name: String(p?.memberName ?? p?.roleName ?? 'Agent'), status: 'idle' }]);
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

export function handleTurnEvent(t: string, e: Record<string, unknown>) {
  const pa = usePrimaryAgentStore.getState();
  const did = String(e.driverId ?? e.instanceId ?? '');
  if (pa.instanceId && did !== pa.instanceId) return;
  if (t !== 'turn.block_updated') return;
  const b = e.block as { blockId?: string; type?: string; content?: string } | undefined;
  if (!b?.blockId || b.type !== 'text') return;
  const msg = { id: b.blockId, role: 'agent' as const, content: b.content ?? '', time: String(e.ts ?? '') };
  const ms = useMessageStore.getState();
  if (ms.messages.some((m) => m.id === msg.id)) ms.replaceMessage(msg.id, msg);
  else ms.addMessage(msg);
}

export function handleTeamEvent(t: string, e: Record<string, unknown>) {
  const ts = useTeamStore.getState();
  if (t === 'team.created') {
    const p = (e.payload ?? e) as Record<string, unknown>;
    ts.addTeam(p as unknown as TeamRow);
  } else if (t === 'team.disbanded') {
    const id = String((e.payload as Record<string, unknown>)?.id ?? e.teamId ?? '');
    if (id) ts.removeTeam(id);
  } else if (t === 'team.member_joined' || t === 'team.member_left') {
    const id = String((e.payload as Record<string, unknown>)?.teamId ?? e.teamId ?? '');
    const team = ts.teams.find((tm) => tm.id === id);
    if (team) ts.updateTeam(id, { ...team });
  }
}

export function handleOtherEvent(t: string, e: Record<string, unknown>) {
  if (t === 'notification.delivered') {
    useNotificationStore.getState().push({
      id: String(e.eventId ?? e.sourceEventId ?? Date.now()),
      title: String(e.sourceEventType ?? 'notification'), message: '', time: String(e.ts ?? ''),
    });
  } else if (t === 'comm.message_sent' || t === 'comm.message_received') {
    const ms = useMessageStore.getState();
    const id = String(e.messageId ?? e.eventId ?? Date.now());
    if (!ms.messages.some((m) => m.id === id)) ms.addMessage({ id, role: 'agent', content: '', time: String(e.ts ?? '') });
  }
}
