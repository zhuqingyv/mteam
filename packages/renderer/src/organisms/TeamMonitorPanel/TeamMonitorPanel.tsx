import { useState } from 'react';
import TeamSidebar from '../../molecules/TeamSidebar';
import TeamCanvas from '../TeamCanvas';
import './TeamMonitorPanel.css';

interface Team { id: string; name: string; memberCount: number; }
interface Agent {
  id: string; name: string; status: string;
  lastMessage?: string; x: number; y: number;
}

interface TeamMonitorPanelProps {
  teams: Team[];
  agents: Agent[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  onCreateTeam?: () => void;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
}

export default function TeamMonitorPanel({
  teams, agents, activeTeamId, onSelectTeam, onCreateTeam, onAgentDragEnd,
}: TeamMonitorPanelProps) {
  const [active, setActive] = useState(activeTeamId ?? teams[0]?.id);
  const handleSelect = (id: string) => {
    setActive(id);
    onSelectTeam?.(id);
  };
  return (
    <div className="team-monitor">
      <TeamSidebar
        teams={teams}
        activeTeamId={activeTeamId ?? active}
        onSelectTeam={handleSelect}
        onCreateTeam={onCreateTeam}
      />
      <TeamCanvas agents={agents} onAgentDragEnd={onAgentDragEnd} />
    </div>
  );
}
