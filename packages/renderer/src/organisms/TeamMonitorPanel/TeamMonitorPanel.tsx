import type { ReactNode } from 'react';
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
  onDisbandTeam?: (id: string) => void;
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
  /** 当前展开节点 id 栈；栈顶 focused */
  expandedIds?: string[];
  onExpandedDragEnd?: (id: string, x: number, y: number) => void;
  onExpandedMinimize?: (id: string) => void;
  onExpandedClose?: (id: string) => void;
  renderExpandedBody?: (id: string) => ReactNode;
}

export default function TeamMonitorPanel({
  teams, agents, activeTeamId, onSelectTeam, onCreateTeam, onDisbandTeam,
  onAgentDragEnd, onAgentOpen,
  onNodeElement, canvasSize,
  canvasTransform, onCanvasTransformCommit,
  collapsed = false, onToggleCollapsed,
  zoomPercent, onFit, onResetZoom, onNewMember, onSettings, onClose,
  expandedIds, onExpandedDragEnd, onExpandedMinimize, onExpandedClose, renderExpandedBody,
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
            onDisbandTeam={onDisbandTeam}
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
            expandedIds={expandedIds}
            onExpandedDragEnd={onExpandedDragEnd}
            onExpandedMinimize={onExpandedMinimize}
            onExpandedClose={onExpandedClose}
            renderExpandedBody={renderExpandedBody}
          />
        </div>
      </div>
    </div>
  );
}
