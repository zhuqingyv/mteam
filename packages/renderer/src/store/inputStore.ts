import { create } from 'zustand';

interface InputState {
  text: string;
  setText: (v: string) => void;
  clear: () => void;
}

export const useInputStore = create<InputState>()((set) => ({
  text: '',
  setText: (v) => set({ text: v }),
  clear: () => set({ text: '' }),
}));
