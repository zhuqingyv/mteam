import { create } from 'zustand';
import type { ToolCall } from '../molecules/ToolCallList';

export interface TurnBlockIO {
  display?: string;
  [key: string]: unknown;
}

export interface TurnBlock {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result';
  blockId: string;
  content?: string;
  toolName?: string;
  title?: string;
  status?: string;
  summary?: string;
  input?: TurnBlockIO;
  output?: TurnBlockIO;
  startTs?: string;
  updatedTs?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
  turnId?: string;
  blocks?: TurnBlock[];
  streaming?: boolean;
}

interface MessageState {
  messages: Message[];
  addMessage: (m: Message) => void;
  replaceMessage: (id: string, m: Message) => void;
  setMessages: (list: Message[]) => void;
  clear: () => void;
  updateTurnBlock: (turnId: string, block: TurnBlock) => void;
  removeTurnBlocksByType: (turnId: string, type: TurnBlock['type']) => void;
  completeTurn: (turnId: string) => void;
}

const MAX_MESSAGES = 1000;

export const useMessageStore = create<MessageState>()((set) => ({
  messages: [],
  addMessage: (m) =>
    set((s) => {
      const next = [...s.messages, m];
      return { messages: next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next };
    }),
  replaceMessage: (id, m) =>
    set((s) => ({ messages: s.messages.map((it) => (it.id === id ? m : it)) })),
  setMessages: (list) => set({ messages: list }),
  clear: () => set({ messages: [] }),
  updateTurnBlock: (turnId, block) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.turnId !== turnId) return m;
        const blocks = m.blocks ?? [];
        const idx = blocks.findIndex((b) => b.blockId === block.blockId);
        return { ...m, blocks: idx >= 0 ? blocks.map((b, i) => (i === idx ? block : b)) : [...blocks, block] };
      }),
    })),
  removeTurnBlocksByType: (turnId, type) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.turnId !== turnId) return m;
        const blocks = m.blocks ?? [];
        return { ...m, blocks: blocks.filter((b) => b.type !== type) };
      }),
    })),
  completeTurn: (turnId) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.turnId !== turnId) return m;
        const blocks = (m.blocks ?? []).filter((b) => b.type !== 'thinking');
        return { ...m, streaming: false, thinking: false, blocks };
      }),
    })),
}));

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __useMessageStore?: typeof useMessageStore }).__useMessageStore = useMessageStore;
}

export const selectMessages = (s: MessageState) => s.messages;
export const selectAddMessage = (s: MessageState) => s.addMessage;
export const selectReplaceMessage = (s: MessageState) => s.replaceMessage;
export const selectSetMessages = (s: MessageState) => s.setMessages;
export const selectClearMessages = (s: MessageState) => s.clear;
export const selectUpdateTurnBlock = (s: MessageState) => s.updateTurnBlock;
export const selectCompleteTurn = (s: MessageState) => s.completeTurn;
