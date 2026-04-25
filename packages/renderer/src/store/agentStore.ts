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

const INITIAL_AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude', active: true },
  { id: 'codex', name: 'Codex' },
  { id: 'qwen', name: 'Qwen' },
  { id: 'deepseek', name: 'DeepSeek' },
];

export const useAgentStore = create<AgentState>()((set) => ({
  agents: INITIAL_AGENTS,
  activeId: 'claude',
  setAgents: (list) => set({ agents: list }),
  setActive: (id) => set({ activeId: id }),
}));

export const selectAgents = (s: AgentState) => s.agents;
export const selectActiveAgentId = (s: AgentState) => s.activeId;
export const selectSetAgents = (s: AgentState) => s.setAgents;
export const selectSetActiveAgent = (s: AgentState) => s.setActive;
