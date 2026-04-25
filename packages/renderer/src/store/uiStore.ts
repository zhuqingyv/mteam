import { create } from 'zustand';

interface UiState {
  windowMode: 'capsule' | 'chat' | 'pet' | 'settings';
  sidebarOpen: boolean;
}

export const useUiStore = create<UiState>()(() => ({
  windowMode: 'capsule',
  sidebarOpen: false,
}));
