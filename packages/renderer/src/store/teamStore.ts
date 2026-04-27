import { create } from 'zustand';
import type { TeamRow, TeamMemberRow } from '../api/teams';

interface TeamState {
  teams: TeamRow[];
  activeTeamId: string | null;
  teamMembers: Record<string, TeamMemberRow[]>;
  setTeams: (teams: TeamRow[]) => void;
  addTeam: (team: TeamRow) => void;
  removeTeam: (id: string) => void;
  updateTeam: (id: string, patch: Partial<TeamRow>) => void;
  setActiveTeam: (id: string | null) => void;
  setTeamMembers: (teamId: string, members: TeamMemberRow[]) => void;
  addTeamMember: (teamId: string, member: TeamMemberRow) => void;
  removeTeamMember: (teamId: string, instanceId: string) => void;
}

export const useTeamStore = create<TeamState>()((set) => ({
  teams: [],
  activeTeamId: null,
  teamMembers: {},
  setTeams: (teams) => set({ teams }),
  addTeam: (team) => set((s) => ({ teams: [...s.teams, team] })),
  removeTeam: (id) => set((s) => {
    const { [id]: _, ...rest } = s.teamMembers;
    return {
      teams: s.teams.filter((t) => t.id !== id),
      activeTeamId: s.activeTeamId === id ? null : s.activeTeamId,
      teamMembers: rest,
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
}));

export const selectTeams = (s: TeamState) => s.teams;
export const selectActiveTeamId = (s: TeamState) => s.activeTeamId;
