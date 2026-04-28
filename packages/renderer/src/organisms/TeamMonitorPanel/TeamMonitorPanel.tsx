import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import TeamSidebar from '../../molecules/TeamSidebar';
import TeamCanvas from '../TeamCanvas';
import type { Transform } from '../../hooks/useCanvasTransform';
import type { CanvasNodeData } from '../../types/chat';
import { useLocale } from '../../i18n';
import './TeamMonitorPanel.css';

interface Team { id: string; name: string; memberCount: number; }

interface TeamMonitorPanelProps {
  teams: Team[];
  agents: CanvasNodeData[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  onCreateTeam?: () => void;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
  onAgentOpen?: (id: string) => void;
  canvasTransform?: Transform;
  onCanvasTransformCommit?: (t: Transform) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function TeamMonitorPanel({
  teams, agents, activeTeamId, onSelectTeam, onCreateTeam, onAgentDragEnd, onAgentOpen,
  canvasTransform, onCanvasTransformCommit,
  collapsed = false, onToggleCollapsed,
}: TeamMonitorPanelProps) {
  const { t } = useLocale();
  const memberCount = agents.length;
  const activeTeam = teams.find((tm) => tm.id === activeTeamId) ?? teams[0];
  const capsuleName = activeTeam?.name ?? (teams.length > 0 ? t('capsule.teams', { count: teams.length }) : 'TEAMS');

  const cls = ['team-monitor'];
  if (collapsed) cls.push('team-monitor--collapsed');

  return (
    <div className={cls.join(' ')}>
      <button
        type="button"
        className="team-monitor__collapsed-face"
        onClick={() => onToggleCollapsed?.()}
        aria-label={t('toolbar.expand_team_panel')}
      >
        <span className="team-monitor__cap-name">{capsuleName}</span>
        <span className="team-monitor__cap-meta">
          {t('capsule.teams_agents', { teams: teams.length, agents: memberCount })}
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
        <TeamCanvas
          key={activeTeamId ?? '__none'}
          agents={agents}
          initialTransform={canvasTransform}
          onAgentDragEnd={onAgentDragEnd}
          onAgentOpen={onAgentOpen}
          onTransformCommit={onCanvasTransformCommit}
        />
      </div>
    </div>
  );
}
