import { create } from 'zustand';

export interface Agent {
  id: string;
  name: string;
  icon?: string;
  online?: boolean;
  active?: boolean;
  status?: 'idle' | 'running' | 'offline';
}

interface AgentState {
  agents: Agent[];
  activeId?: string;
  setAgents: (list: Agent[]) => void;
  setActiveAgent: (id: string) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  agents: [],
  activeId: undefined,
  setAgents: (list) => set({ agents: list }),
  setActiveAgent: (id) => set({ activeId: id }),
}));

export const selectAgents = (s: AgentState) => s.agents;
export const selectActiveAgentId = (s: AgentState) => s.activeId;
export const selectSetAgents = (s: AgentState) => s.setAgents;
export const selectSetActiveAgent = (s: AgentState) => s.setActiveAgent;
