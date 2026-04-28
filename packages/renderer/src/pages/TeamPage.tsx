import { useEffect, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import Surface from '../atoms/Surface';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Text from '../atoms/Text';
import { listTeams, getTeam, createTeam } from '../api/teams';
import { useTeamStore, usePrimaryAgentStore, useAgentStore } from '../store';
import './TeamPage.css';

export default function TeamPage() {
  const [collapsed, setCollapsed] = useState(false);
  const teams = useTeamStore((s) => s.teams);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const teamMembers = useTeamStore((s) => s.teamMembers);
  const setTeams = useTeamStore((s) => s.setTeams);
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam);
  const setTeamMembers = useTeamStore((s) => s.setTeamMembers);
  const leaderInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const agentPool = useAgentStore((s) => s.agents);

  useEffect(() => {
    listTeams().then((r) => { if (r.ok && r.data) setTeams(r.data); }).catch(() => {});
  }, [setTeams]);

  // activeTeamId 变化：HTTP 拉成员列表补齐（WS 只能补增量，首次/切换要全量）。
  useEffect(() => {
    if (!activeTeamId) return;
    getTeam(activeTeamId).then((r) => {
      if (r.ok && r.data) setTeamMembers(activeTeamId, r.data.members);
    }).catch(() => {});
  }, [activeTeamId, setTeamMembers]);

  const hasTeams = teams.length > 0;
  // 新建 team 后自动从胶囊态展开（PRD Case 2）。
  useEffect(() => { if (hasTeams) setCollapsed(false); }, [hasTeams]);

  const sidebarTeams = teams.map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: (teamMembers[t.id] ?? []).length,
  }));

  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const leaderId = activeTeam?.leaderInstanceId;
  const currentMembers = activeTeamId ? (teamMembers[activeTeamId] ?? []) : [];

  const cards: { id: string; name: string; status: string; isLeader: boolean }[] = [];
  if (leaderId) {
    const pool = agentPool.find((a) => a.id === leaderId);
    cards.push({
      id: leaderId,
      name: pool?.name ?? 'Leader',
      status: pool?.status ?? 'idle',
      isLeader: true,
    });
  }
  for (const m of currentMembers) {
    if (m.instanceId === leaderId) continue;
    const pool = agentPool.find((a) => a.id === m.instanceId);
    cards.push({
      id: m.instanceId,
      name: m.roleInTeam ?? pool?.name ?? m.instanceId,
      status: pool?.status ?? 'idle',
      isLeader: false,
    });
  }

  const agents = cards.map((c, i) => ({
    id: c.id,
    name: c.name,
    status: c.status === 'running' ? 'working' : c.status === 'offline' ? 'shutdown' : 'idle',
    x: 120 + i * 200,
    y: 140,
  }));

  const handleSelectTeam = (id: string) => setActiveTeam(id);

  const handleCreateTeam = () => {
    const name = window.prompt('Team name');
    if (!name?.trim() || !leaderInstanceId) return;
    createTeam({ name: name.trim(), leaderInstanceId }).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') window.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <PanelWindow>
      <div className="team-page__close">
        <Button variant="icon" size="sm" onClick={() => window.close()}>
          <Icon name="close" size={20} />
        </Button>
      </div>
      {hasTeams ? (
        <TeamMonitorPanel
          teams={sidebarTeams}
          agents={agents}
          activeTeamId={activeTeamId ?? undefined}
          onSelectTeam={handleSelectTeam}
          onCreateTeam={handleCreateTeam}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
        />
      ) : (
        <div className="team-page__empty">
          <Surface variant="panel">
            <div className="team-page__empty-inner">
              <div className="team-page__empty-icon" aria-hidden>
                <Icon name="team" size={32} />
              </div>
              <Text variant="title">尚未创建团队</Text>
              <Text variant="subtitle">
                让主 Agent 帮你拉起第一个团队，开始协作
              </Text>
              <div className="team-page__empty-actions">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleCreateTeam}
                  disabled={!leaderInstanceId}
                >
                  创建团队
                </Button>
              </div>
            </div>
          </Surface>
        </div>
      )}
    </PanelWindow>
  );
}
