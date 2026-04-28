import { useCallback, useEffect, useMemo, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import Surface from '../atoms/Surface';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Text from '../atoms/Text';
import { CanvasNodeExpanded } from '../molecules/CanvasNode';
import { listTeams, getTeam, createTeam } from '../api/teams';
import { useTeamStore, usePrimaryAgentStore, useAgentStore, useMessageStore } from '../store';
import { computeLayout } from '../organisms/TeamCanvas/layout';
import { useCanvasHotkeys } from '../hooks/useCanvasHotkeys';
import { useExpandedStack } from '../hooks/useExpandedStack';
import { buildTeamAgents } from './teamPageSelectors';
import type { Transform } from '../hooks/useCanvasTransform';
import type { CanvasNodeData } from '../types/chat';
import './TeamPage.css';

const DEFAULT_CANVAS: { width: number; height: number } = { width: 960, height: 560 };

export default function TeamPage() {
  const [collapsed, setCollapsed] = useState(false);
  const [transformEpoch, setTransformEpoch] = useState(0);
  const { stack, open, close, popTop, registerNodeEl, getNodeEl, anchorTick } = useExpandedStack();
  const teams = useTeamStore((s) => s.teams);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const teamMembers = useTeamStore((s) => s.teamMembers);
  const canvasStates = useTeamStore((s) => s.canvasStates);
  const setTeams = useTeamStore((s) => s.setTeams);
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam);
  const setTeamMembers = useTeamStore((s) => s.setTeamMembers);
  const saveCanvasState = useTeamStore((s) => s.saveCanvasState);
  const updateNodePosition = useTeamStore((s) => s.updateNodePosition);
  const leaderInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const agentPool = useAgentStore((s) => s.agents);
  const byInstance = useMessageStore((s) => s.byInstance);

  useEffect(() => {
    listTeams().then((r) => { if (r.ok && r.data) setTeams(r.data); }).catch(() => {});
  }, [setTeams]);

  useEffect(() => {
    if (!activeTeamId) return;
    getTeam(activeTeamId).then((r) => {
      if (r.ok && r.data) setTeamMembers(activeTeamId, r.data.members);
    }).catch(() => {});
  }, [activeTeamId, setTeamMembers]);

  const hasTeams = teams.length > 0;
  useEffect(() => { if (hasTeams) setCollapsed(false); }, [hasTeams]);

  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const leaderId = activeTeam?.leaderInstanceId;
  const currentMembers = activeTeamId ? (teamMembers[activeTeamId] ?? []) : [];
  const savedCanvas = activeTeamId ? canvasStates[activeTeamId] : undefined;

  const agents: CanvasNodeData[] = useMemo(
    () => buildTeamAgents({
      leaderId,
      members: currentMembers,
      agentPool,
      byInstance,
      layoutFn: (cards) => computeLayout(cards, DEFAULT_CANVAS, savedCanvas?.nodePositions ?? {}),
    }),
    [leaderId, currentMembers, agentPool, byInstance, savedCanvas],
  );

  const sidebarTeams = teams.map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: (teamMembers[t.id] ?? []).length,
  }));

  const handleCreateTeam = () => {
    const name = window.prompt('Team name');
    if (!name?.trim() || !leaderInstanceId) return;
    createTeam({ name: name.trim(), leaderInstanceId }).catch(() => {});
  };

  const handleAgentDragEnd = (id: string, x: number, y: number) => {
    if (!activeTeamId) return;
    updateNodePosition(activeTeamId, id, { x, y });
  };

  const handleCanvasTransformCommit = (t: Transform) => {
    setTransformEpoch((n) => n + 1);
    if (!activeTeamId) return;
    const prev = canvasStates[activeTeamId];
    saveCanvasState(activeTeamId, {
      pan: { x: t.x, y: t.y },
      zoom: t.zoom,
      nodePositions: prev?.nodePositions ?? {},
    });
  };

  const canvasTransform: Transform | undefined = savedCanvas
    ? { x: savedCanvas.pan.x, y: savedCanvas.pan.y, zoom: savedCanvas.zoom }
    : undefined;

  const closeTopOrWindow = useCallback(() => {
    const popped = popTop();
    if (popped === null) window.close();
  }, [popTop]);

  useCanvasHotkeys({ onEscape: closeTopOrWindow });

  const agentById = useMemo(() => {
    const m = new Map<string, CanvasNodeData>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

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
          onSelectTeam={setActiveTeam}
          onCreateTeam={handleCreateTeam}
          onAgentDragEnd={handleAgentDragEnd}
          onAgentOpen={open}
          onNodeElement={registerNodeEl}
          canvasSize={DEFAULT_CANVAS}
          canvasTransform={canvasTransform}
          onCanvasTransformCommit={handleCanvasTransformCommit}
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
              <Text variant="subtitle">让主 Agent 帮你拉起第一个团队，开始协作</Text>
              <div className="team-page__empty-actions">
                <Button variant="primary" size="md" onClick={handleCreateTeam} disabled={!leaderInstanceId}>
                  创建团队
                </Button>
              </div>
            </div>
          </Surface>
        </div>
      )}
      {stack.map((id, idx) => {
        const data = agentById.get(id);
        if (!data) return null;
        return (
          <CanvasNodeExpanded
            key={id}
            id={id}
            name={data.name}
            status={data.status}
            anchorEl={getNodeEl(id)}
            expandedIndex={idx}
            focused={idx === stack.length - 1}
            transformEpoch={transformEpoch + anchorTick}
            teamId={activeTeamId ?? null}
            onMinimize={() => close(id)}
            onClose={() => close(id)}
          />
        );
      })}
    </PanelWindow>
  );
}
