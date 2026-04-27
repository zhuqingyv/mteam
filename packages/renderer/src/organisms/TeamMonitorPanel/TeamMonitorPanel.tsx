import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import TeamSidebar from '../../molecules/TeamSidebar';
import TeamCanvas from '../TeamCanvas';
import './TeamMonitorPanel.css';

interface Team { id: string; name: string; memberCount: number; }
interface Agent {
  id: string; name: string; status: string; cliType?: string;
  lastMessage?: string; x: number; y: number;
}

interface TeamMonitorPanelProps {
  teams: Team[];
  agents: Agent[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  onCreateTeam?: () => void;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function TeamMonitorPanel({
  teams, agents, activeTeamId, onSelectTeam, onCreateTeam, onAgentDragEnd,
  collapsed = false, onToggleCollapsed,
}: TeamMonitorPanelProps) {
  const memberCount = agents.length;
  const activeTeam = teams.find((t) => t.id === activeTeamId) ?? teams[0];
  const capsuleName = activeTeam?.name ?? (teams.length > 0 ? `${teams.length} Teams` : 'TEAMS');

  const cls = ['team-monitor'];
  if (collapsed) cls.push('team-monitor--collapsed');

  return (
    <div className={cls.join(' ')}>
      <button
        type="button"
        className="team-monitor__collapsed-face"
        onClick={() => onToggleCollapsed?.()}
        aria-label="展开团队面板"
      >
        <span className="team-monitor__cap-name">{capsuleName}</span>
        <span className="team-monitor__cap-meta">
          {teams.length} Teams · {memberCount} Agents
        </span>
      </button>

      <div className="team-monitor__expanded">
        <div className="team-monitor__close">
          <Button variant="icon" size="sm" onClick={() => onToggleCollapsed?.()}>
            <Icon name="close" size={14} />
          </Button>
        </div>
        <TeamSidebar
          teams={teams}
          activeTeamId={activeTeamId}
          onSelectTeam={onSelectTeam}
          onCreateTeam={onCreateTeam}
        />
        <TeamCanvas agents={agents} onAgentDragEnd={onAgentDragEnd} />
      </div>
    </div>
  );
}
