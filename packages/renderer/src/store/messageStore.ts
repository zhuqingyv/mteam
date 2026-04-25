import { create } from 'zustand';
import type { ToolCall } from '../molecules/ToolCallList';
import { INITIAL_MESSAGES } from './messageStore.mock';

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
  setMessages: (list: Message[]) => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>()((set) => ({
  messages: INITIAL_MESSAGES,
  append: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setMessages: (list) => set({ messages: list }),
  clear: () => set({ messages: [] }),
}));

export const selectMessages = (s: MessageState) => s.messages;
export const selectAppendMessage = (s: MessageState) => s.append;
export const selectSetMessages = (s: MessageState) => s.setMessages;
export const selectClearMessages = (s: MessageState) => s.clear;
