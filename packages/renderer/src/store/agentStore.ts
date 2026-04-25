import { create } from 'zustand';

export interface Agent {
  id: string;
  name: string;
  icon?: string;
  online?: boolean;
  active?: boolean;
}

interface AgentState {
  agents: Agent[];
  activeId?: string;
  setAgents: (list: Agent[]) => void;
  setActive: (id: string) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  agents: [],
  activeId: undefined,
  setAgents: (list) => set({ agents: list }),
  setActive: (id) => set({ activeId: id }),
}));
