import { create } from 'zustand';
import type { WsClient } from '../api/ws';

interface WsState {
  client: WsClient | null;
  setClient: (c: WsClient | null) => void;
}

export const useWsStore = create<WsState>()((set) => ({
  client: null,
  setClient: (c) => set({ client: c }),
}));
