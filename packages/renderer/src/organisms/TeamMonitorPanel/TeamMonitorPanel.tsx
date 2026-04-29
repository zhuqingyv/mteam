import TeamSidebar from '../../molecules/TeamSidebar';
import CanvasTopBar from '../../molecules/CanvasTopBar';
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
  onNodeElement?: (id: string, el: HTMLElement | null) => void;
  canvasSize?: { width: number; height: number };
  canvasTransform?: Transform;
  onCanvasTransformCommit?: (t: Transform) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  // S4-G3 顶栏：关闭 / 缩放 / 新成员 / 设置
  zoomPercent: number;
  onFit?: () => void;
  onResetZoom?: () => void;
  onNewMember?: () => void;
  onSettings?: () => void;
  onClose?: () => void;
}

export default function TeamMonitorPanel({
  teams, agents, activeTeamId, onSelectTeam, onCreateTeam, onAgentDragEnd, onAgentOpen,
  onNodeElement, canvasSize,
  canvasTransform, onCanvasTransformCommit,
  collapsed = false, onToggleCollapsed,
  zoomPercent, onFit, onResetZoom, onNewMember, onSettings, onClose,
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
        <CanvasTopBar
          teamName={capsuleName}
          memberCount={memberCount}
          zoomPercent={zoomPercent}
          onZoomMenu={onResetZoom}
          onFit={onFit}
          onNewMember={onNewMember}
          onSettings={onSettings}
          onClose={onClose}
        />
        <div className="team-monitor__body">
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
            onNodeElement={onNodeElement}
            canvasSize={canvasSize}
            onTransformCommit={onCanvasTransformCommit}
          />
        </div>
      </div>
    </div>
  );
}
