import { useCallback, useEffect, useMemo, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import { CanvasNodeExpanded } from '../molecules/CanvasNode';
import { listTeams, getTeam, createTeam } from '../api/teams';
import { useTeamStore, usePrimaryAgentStore, useAgentStore, useMessageStore } from '../store';
import { computeLayout } from '../organisms/TeamCanvas/layout';
import { useCanvasHotkeys } from '../hooks/useCanvasHotkeys';
import { useExpandedStack } from '../hooks/useExpandedStack';
import { computeFitTransform } from '../hooks/useCanvasControls';
import { buildTeamAgents } from './teamPageSelectors';
import TeamPageEmpty from './TeamPageEmpty';
import type { Transform } from '../hooks/useCanvasTransform';
import type { CanvasNodeData } from '../types/chat';
import './TeamPage.css';

const DEFAULT_CANVAS: { width: number; height: number } = { width: 960, height: 560 };
// 节点默认尺寸估计值，用于 fit 时的包围盒计算（CanvasNode 收起态 ~180x80）。
const NODE_BBOX = { w: 180, h: 80 };

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

  // 把新 transform 写回 team store；bumpEpoch=true 时同时刷新展开面板锚点。
  // pan/zoom commit 会 bump；fit/reset 程序性触发不 bump（TeamCanvas 内 useEffect 已统一刷 DOM）。
  const commitTransform = useCallback(
    (t: Transform, bumpEpoch = false) => {
      if (bumpEpoch) setTransformEpoch((n) => n + 1);
      if (!activeTeamId) return;
      const prev = canvasStates[activeTeamId];
      saveCanvasState(activeTeamId, {
        pan: { x: t.x, y: t.y },
        zoom: t.zoom,
        nodePositions: prev?.nodePositions ?? {},
      });
    },
    [activeTeamId, canvasStates, saveCanvasState],
  );

  const canvasTransform: Transform | undefined = savedCanvas
    ? { x: savedCanvas.pan.x, y: savedCanvas.pan.y, zoom: savedCanvas.zoom }
    : undefined;

  const zoomPercent = Math.round((canvasTransform?.zoom ?? 1) * 100);

  // S5-G3 hotkeys + S4-M4 controls：onFit 按节点包围盒居中缩放；onResetZoom 回原点 100%。
  const handleFit = useCallback(() => {
    const bboxes = agents.map((a) => ({ x: a.x, y: a.y, w: NODE_BBOX.w, h: NODE_BBOX.h }));
    commitTransform(computeFitTransform(bboxes, { w: DEFAULT_CANVAS.width, h: DEFAULT_CANVAS.height }));
  }, [agents, commitTransform]);

  const handleResetZoom = useCallback(() => {
    commitTransform({ x: 0, y: 0, zoom: 1 });
  }, [commitTransform]);

  const closeTopOrWindow = useCallback(() => {
    const popped = popTop();
    if (popped === null) window.close();
  }, [popTop]);

  useCanvasHotkeys({
    onEscape: closeTopOrWindow,
    onFit: handleFit,
    onResetZoom: handleResetZoom,
  });

  const agentById = useMemo(() => {
    const m = new Map<string, CanvasNodeData>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  return (
    <PanelWindow>
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
          onCanvasTransformCommit={(t) => commitTransform(t, true)}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          zoomPercent={zoomPercent}
          onFit={handleFit}
          onResetZoom={handleResetZoom}
          onClose={() => window.close()}
        />
      ) : (
        <TeamPageEmpty onCreateTeam={handleCreateTeam} canCreate={!!leaderInstanceId} />
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
