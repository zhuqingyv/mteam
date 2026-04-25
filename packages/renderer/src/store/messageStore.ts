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
  addMessage: (m: Message) => void;
  replaceMessage: (id: string, m: Message) => void;
  setMessages: (list: Message[]) => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>()((set) => ({
  messages: [],
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  replaceMessage: (id, m) =>
    set((s) => ({ messages: s.messages.map((it) => (it.id === id ? m : it)) })),
  setMessages: (list) => set({ messages: list }),
  clear: () => set({ messages: [] }),
}));

export const selectMessages = (s: MessageState) => s.messages;
export const selectAddMessage = (s: MessageState) => s.addMessage;
export const selectReplaceMessage = (s: MessageState) => s.replaceMessage;
export const selectSetMessages = (s: MessageState) => s.setMessages;
export const selectClearMessages = (s: MessageState) => s.clear;
