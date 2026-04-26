import { useEffect, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import { listTeams, getTeam, createTeam } from '../api/teams';
import type { TeamWithMembers } from '../api/teams';
import { useTeamStore, usePrimaryAgentStore } from '../store';

export default function TeamPage() {
  const teams = useTeamStore((s) => s.teams);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const setTeams = useTeamStore((s) => s.setTeams);
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam);
  const leaderInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const [members, setMembers] = useState<TeamWithMembers['members']>([]);

  useEffect(() => {
    listTeams().then((r) => { if (r.ok && r.data) setTeams(r.data); }).catch(() => {});
  }, [setTeams]);

  const sidebarTeams = teams.map((t) => ({ id: t.id, name: t.name, memberCount: 0 }));

  const agents = members.map((m, i) => ({
    id: m.instanceId,
    name: m.roleInTeam ?? m.instanceId,
    status: 'idle',
    x: 120 + i * 200,
    y: 140,
  }));

  const handleSelectTeam = (id: string) => {
    setActiveTeam(id);
    getTeam(id).then((r) => { if (r.ok && r.data) setMembers(r.data.members); }).catch(() => {});
  };

  const handleCreateTeam = () => {
    const name = window.prompt('Team name');
    if (!name?.trim() || !leaderInstanceId) return;
    createTeam({ name: name.trim(), leaderInstanceId }).catch(() => {});
  };

  return (
    <PanelWindow>
      <TeamMonitorPanel
        teams={sidebarTeams}
        agents={agents}
        activeTeamId={activeTeamId ?? undefined}
        onSelectTeam={handleSelectTeam}
        onCreateTeam={handleCreateTeam}
      />
    </PanelWindow>
  );
}
