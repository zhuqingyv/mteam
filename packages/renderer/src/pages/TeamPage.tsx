import { useCallback, useEffect, useMemo, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import CanvasNodeChatBody from '../molecules/CanvasNode/CanvasNodeChatBody';
import ConfirmDialog from '../molecules/ConfirmDialog';
import { listTeams, getTeam, createTeam, disbandTeam } from '../api/teams';
import { listInstances } from '../api/instances';
import { useTeamStore, usePrimaryAgentStore, useAgentStore, useMessageStore } from '../store';
import { useLocale } from '../i18n';
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
  const [disbandTarget, setDisbandTarget] = useState<{ id: string; name: string } | null>(null);
  const { t } = useLocale();
  const { stack, open, close, popTop, registerNodeEl } = useExpandedStack();
  const teams = useTeamStore((s) => s.teams);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const teamMembers = useTeamStore((s) => s.teamMembers);
  const canvasStates = useTeamStore((s) => s.canvasStates);
  const setTeams = useTeamStore((s) => s.setTeams);
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam);
  const setTeamMembers = useTeamStore((s) => s.setTeamMembers);
  const removeTeam = useTeamStore((s) => s.removeTeam);
  const saveCanvasState = useTeamStore((s) => s.saveCanvasState);
  const updateNodePosition = useTeamStore((s) => s.updateNodePosition);
  const leaderInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const agentPool = useAgentStore((s) => s.agents);
  const setAgents = useAgentStore((s) => s.setAgents);
  const byInstance = useMessageStore((s) => s.byInstance);

  // 首次打开 team 窗口：拉 teams；若无激活 team，自动选第一个，让画布有节点。
  useEffect(() => {
    listTeams().then((r) => {
      if (!r.ok || !r.data) return;
      setTeams(r.data);
      const s = useTeamStore.getState();
      if (!s.activeTeamId && r.data.length > 0) s.setActiveTeam(r.data[0].id);
    }).catch(() => {});
  }, [setTeams]);

  // agentPool 的 name/status 用于节点渲染；仅靠 WS instance.* 事件无法在独立
  // 窗口冷启动时补齐（事件是增量），所以打开窗口时拉一次全量实例灌入 agentStore。
  useEffect(() => {
    listInstances().then((r) => {
      if (!r.ok || !r.data) return;
      setAgents(r.data.map((i) => ({
        id: i.id,
        name: i.memberName,
        status: i.status === 'PENDING_OFFLINE' ? 'offline' : 'idle',
      })));
    }).catch(() => {});
  }, [setAgents]);

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

  const handleDisbandRequest = (id: string) => {
    const target = teams.find((t) => t.id === id);
    if (!target) return;
    setDisbandTarget({ id, name: target.name });
  };

  const handleDisbandConfirm = async () => {
    if (!disbandTarget) return;
    const id = disbandTarget.id;
    setDisbandTarget(null);
    const r = await disbandTeam(id);
    if (!r.ok) return;
    // 先挑下一个要激活的 team，再从 store 移除（removeTeam 会把 activeTeamId 置 null）
    const remaining = teams.filter((t) => t.id !== id);
    const nextActive = activeTeamId === id ? (remaining[0]?.id ?? null) : activeTeamId;
    removeTeam(id);
    if (nextActive !== activeTeamId) setActiveTeam(nextActive);
  };

  const handleAgentDragEnd = (id: string, x: number, y: number) => {
    if (!activeTeamId) return;
    updateNodePosition(activeTeamId, id, { x, y });
  };

  // 展开态顶栏拖动 —— 复用同一张 nodePositions，下次收起时位置保留
  const handleExpandedDragEnd = (id: string, x: number, y: number) => {
    if (!activeTeamId) return;
    updateNodePosition(activeTeamId, id, { x, y });
  };

  const commitTransform = useCallback(
    (t: Transform) => {
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

  const renderExpandedBody = useCallback(
    (id: string) => (
      <CanvasNodeChatBody instanceId={id} teamId={activeTeamId ?? null} />
    ),
    [activeTeamId],
  );

  return (
    <PanelWindow>
      {hasTeams ? (
        <TeamMonitorPanel
          teams={sidebarTeams}
          agents={agents}
          activeTeamId={activeTeamId ?? undefined}
          onSelectTeam={setActiveTeam}
          onCreateTeam={handleCreateTeam}
          onDisbandTeam={handleDisbandRequest}
          onAgentDragEnd={handleAgentDragEnd}
          onAgentOpen={open}
          onNodeElement={registerNodeEl}
          canvasSize={DEFAULT_CANVAS}
          canvasTransform={canvasTransform}
          onCanvasTransformCommit={commitTransform}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          zoomPercent={zoomPercent}
          onFit={handleFit}
          onResetZoom={handleResetZoom}
          onClose={() => window.close()}
          expandedIds={stack}
          onExpandedDragEnd={handleExpandedDragEnd}
          onExpandedMinimize={close}
          onExpandedClose={close}
          renderExpandedBody={renderExpandedBody}
        />
      ) : (
        <TeamPageEmpty onCreateTeam={handleCreateTeam} canCreate={!!leaderInstanceId} />
      )}
      <ConfirmDialog
        open={!!disbandTarget}
        title={t('team.disband_confirm_title')}
        message={t('team.disband_confirm_message', { name: disbandTarget?.name ?? '' })}
        variant="danger"
        confirmLabel={t('team.disband')}
        onConfirm={handleDisbandConfirm}
        onCancel={() => setDisbandTarget(null)}
      />
    </PanelWindow>
  );
}
