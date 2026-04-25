import { create } from 'zustand';

export type WindowMode = 'capsule' | 'chat' | 'pet' | 'settings';

interface WindowState {
  mode: WindowMode;
  expanded: boolean;
  setMode: (m: WindowMode) => void;
  toggle: () => void;
}

export const useWindowStore = create<WindowState>()((set) => ({
  mode: 'capsule',
  expanded: false,
  setMode: (m) => set({ mode: m }),
  toggle: () => set((s) => ({ expanded: !s.expanded })),
}));
