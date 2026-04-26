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
  return (
    <div className="team-monitor">
      <TeamSidebar
        teams={teams}
        activeTeamId={activeTeamId}
        onSelectTeam={onSelectTeam}
        onCreateTeam={onCreateTeam}
      />
      <TeamCanvas agents={agents} onAgentDragEnd={onAgentDragEnd} />
    </div>
  );
}
