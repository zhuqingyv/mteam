import { create } from 'zustand';

export type WindowMode = 'capsule' | 'chat' | 'pet' | 'settings';

interface WindowState {
  mode: WindowMode;
  expanded: boolean;
  setMode: (m: WindowMode) => void;
  setExpanded: (v: boolean) => void;
  toggle: () => void;
}

export const useWindowStore = create<WindowState>()((set) => ({
  mode: 'capsule',
  expanded: false,
  setMode: (m) => set({ mode: m }),
  setExpanded: (v) => set({ expanded: v }),
  toggle: () => set((s) => ({ expanded: !s.expanded })),
}));

export const selectWindowMode = (s: WindowState) => s.mode;
export const selectExpanded = (s: WindowState) => s.expanded;
export const selectSetMode = (s: WindowState) => s.setMode;
export const selectSetExpanded = (s: WindowState) => s.setExpanded;
export const selectToggle = (s: WindowState) => s.toggle;
