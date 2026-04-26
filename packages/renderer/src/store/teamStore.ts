import { create } from 'zustand';
import type { TeamRow } from '../api/teams';

interface TeamState {
  teams: TeamRow[];
  activeTeamId: string | null;
  setTeams: (teams: TeamRow[]) => void;
  addTeam: (team: TeamRow) => void;
  removeTeam: (id: string) => void;
  updateTeam: (id: string, patch: Partial<TeamRow>) => void;
  setActiveTeam: (id: string | null) => void;
}

export const useTeamStore = create<TeamState>()((set) => ({
  teams: [],
  activeTeamId: null,
  setTeams: (teams) => set({ teams }),
  addTeam: (team) => set((s) => ({ teams: [...s.teams, team] })),
  removeTeam: (id) => set((s) => ({
    teams: s.teams.filter((t) => t.id !== id),
    activeTeamId: s.activeTeamId === id ? null : s.activeTeamId,
  })),
  updateTeam: (id, patch) => set((s) => ({
    teams: s.teams.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  setActiveTeam: (id) => set({ activeTeamId: id }),
}));

export const selectTeams = (s: TeamState) => s.teams;
export const selectActiveTeamId = (s: TeamState) => s.activeTeamId;
