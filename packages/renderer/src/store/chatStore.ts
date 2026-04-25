import { create } from 'zustand';

interface ChatState {
  messages: { id: string; role: 'user' | 'agent'; content: string; timestamp: number }[];
  inputText: string;
}

export const useChatStore = create<ChatState>()(() => ({
  messages: [],
  inputText: '',
}));
