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

export const selectInputText = (s: InputState) => s.text;
export const selectSetInputText = (s: InputState) => s.setText;
export const selectClearInput = (s: InputState) => s.clear;
