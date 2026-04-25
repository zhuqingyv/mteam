import { create } from 'zustand';

interface TeamState {
  agents: { id: string; name: string; online: boolean }[];
  tasks: { id: string; title: string; status: string }[];
  messages: { id: string; content: string; read: boolean }[];
}

export const useTeamStore = create<TeamState>()(() => ({
  agents: [],
  tasks: [],
  messages: [],
}));
