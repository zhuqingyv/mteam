import { useEffect, useMemo, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';
import Surface from '../atoms/Surface';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Text from '../atoms/Text';
import { listTeams, getTeam, createTeam } from '../api/teams';
import { useTeamStore, usePrimaryAgentStore, useAgentStore } from '../store';
import { computeLayout } from '../organisms/TeamCanvas/layout';
import type { Transform } from '../hooks/useCanvasTransform';
import './TeamPage.css';

const DEFAULT_CANVAS: { width: number; height: number } = { width: 960, height: 560 };

export default function TeamPage() {
  const [collapsed, setCollapsed] = useState(false);
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

  const sidebarTeams = teams.map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: (teamMembers[t.id] ?? []).length,
  }));

  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const leaderId = activeTeam?.leaderInstanceId;
  const currentMembers = activeTeamId ? (teamMembers[activeTeamId] ?? []) : [];

  const cards = useMemo(() => {
    const list: { id: string; name: string; status: string; isLeader: boolean }[] = [];
    if (leaderId) {
      const pool = agentPool.find((a) => a.id === leaderId);
      list.push({
        id: leaderId,
        name: pool?.name ?? 'Leader',
        status: pool?.status ?? 'idle',
        isLeader: true,
      });
    }
    for (const m of currentMembers) {
      if (m.instanceId === leaderId) continue;
      const pool = agentPool.find((a) => a.id === m.instanceId);
      list.push({
        id: m.instanceId,
        name: m.roleInTeam ?? pool?.name ?? m.instanceId,
        status: pool?.status ?? 'idle',
        isLeader: false,
      });
    }
    return list;
  }, [leaderId, currentMembers, agentPool]);

  const savedCanvas = activeTeamId ? canvasStates[activeTeamId] : undefined;

  const positions = useMemo(() => {
    return computeLayout(
      cards.map((c) => ({ id: c.id, isLeader: c.isLeader })),
      DEFAULT_CANVAS,
      savedCanvas?.nodePositions ?? {},
    );
  }, [cards, savedCanvas]);

  const agents = cards.map((c) => {
    const p = positions[c.id] ?? { x: 0, y: 0 };
    return {
      id: c.id,
      name: c.name,
      status: c.status === 'running' ? 'working' : c.status === 'offline' ? 'shutdown' : 'idle',
      x: p.x,
      y: p.y,
      isLeader: c.isLeader,
    };
  });

  const handleSelectTeam = (id: string) => setActiveTeam(id);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') window.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          onSelectTeam={handleSelectTeam}
          onCreateTeam={handleCreateTeam}
          onAgentDragEnd={handleAgentDragEnd}
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
              <Text variant="subtitle">
                让主 Agent 帮你拉起第一个团队，开始协作
              </Text>
              <div className="team-page__empty-actions">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleCreateTeam}
                  disabled={!leaderInstanceId}
                >
                  创建团队
                </Button>
              </div>
            </div>
          </Surface>
        </div>
      )}
    </PanelWindow>
  );
}
