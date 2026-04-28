import { create } from 'zustand';
import type { TeamRow, TeamMemberRow } from '../api/teams';

export interface CanvasState {
  pan: { x: number; y: number };
  zoom: number;
  nodePositions: Record<string, { x: number; y: number }>;
}

interface TeamState {
  teams: TeamRow[];
  activeTeamId: string | null;
  teamMembers: Record<string, TeamMemberRow[]>;
  canvasStates: Record<string, CanvasState>;
  setTeams: (teams: TeamRow[]) => void;
  addTeam: (team: TeamRow) => void;
  removeTeam: (id: string) => void;
  updateTeam: (id: string, patch: Partial<TeamRow>) => void;
  setActiveTeam: (id: string | null) => void;
  setTeamMembers: (teamId: string, members: TeamMemberRow[]) => void;
  addTeamMember: (teamId: string, member: TeamMemberRow) => void;
  removeTeamMember: (teamId: string, instanceId: string) => void;
  saveCanvasState: (teamId: string, state: CanvasState) => void;
  getCanvasState: (teamId: string) => CanvasState | undefined;
  updateNodePosition: (teamId: string, agentId: string, pos: { x: number; y: number }) => void;
}

export const useTeamStore = create<TeamState>()((set, get) => ({
  teams: [],
  activeTeamId: null,
  teamMembers: {},
  canvasStates: {},
  setTeams: (teams) => set({ teams }),
  addTeam: (team) => set((s) => ({ teams: [...s.teams, team] })),
  removeTeam: (id) => set((s) => {
    const { [id]: _m, ...restMembers } = s.teamMembers;
    const { [id]: _c, ...restCanvas } = s.canvasStates;
    return {
      teams: s.teams.filter((t) => t.id !== id),
      activeTeamId: s.activeTeamId === id ? null : s.activeTeamId,
      teamMembers: restMembers,
      canvasStates: restCanvas,
    };
  }),
  updateTeam: (id, patch) => set((s) => ({
    teams: s.teams.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  setActiveTeam: (id) => set({ activeTeamId: id }),
  setTeamMembers: (teamId, members) => set((s) => ({
    teamMembers: { ...s.teamMembers, [teamId]: members },
  })),
  addTeamMember: (teamId, member) => set((s) => {
    const list = s.teamMembers[teamId] ?? [];
    if (list.some((m) => m.instanceId === member.instanceId)) return s;
    return { teamMembers: { ...s.teamMembers, [teamId]: [...list, member] } };
  }),
  removeTeamMember: (teamId, instanceId) => set((s) => {
    const list = s.teamMembers[teamId];
    if (!list) return s;
    return {
      teamMembers: {
        ...s.teamMembers,
        [teamId]: list.filter((m) => m.instanceId !== instanceId),
      },
    };
  }),
  saveCanvasState: (teamId, state) => set((s) => ({
    canvasStates: { ...s.canvasStates, [teamId]: state },
  })),
  getCanvasState: (teamId) => get().canvasStates[teamId],
  updateNodePosition: (teamId, agentId, pos) => set((s) => {
    const prev = s.canvasStates[teamId] ?? {
      pan: { x: 0, y: 0 },
      zoom: 1,
      nodePositions: {},
    };
    return {
      canvasStates: {
        ...s.canvasStates,
        [teamId]: {
          ...prev,
          nodePositions: { ...prev.nodePositions, [agentId]: pos },
        },
      },
    };
  }),
}));

export const selectTeams = (s: TeamState) => s.teams;
export const selectActiveTeamId = (s: TeamState) => s.activeTeamId;
