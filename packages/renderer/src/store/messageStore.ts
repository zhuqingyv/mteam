import { create } from 'zustand';
import type { ToolCall } from '../molecules/ToolCallList';

export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
}

interface MessageState {
  messages: Message[];
  append: (m: Message) => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>()((set) => ({
  messages: [],
  append: (m) => set((s) => ({ messages: [...s.messages, m] })),
  clear: () => set({ messages: [] }),
}));
