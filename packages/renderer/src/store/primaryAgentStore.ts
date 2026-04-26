import { create } from 'zustand';
import type { PrimaryAgentRow } from '../api/primaryAgent';

type PaStatus = 'STOPPED' | 'RUNNING';
type DriverLifecycle = 'idle' | 'ready' | 'stopped' | 'error';

interface PrimaryAgentState {
  config: PrimaryAgentRow | null;
  status: PaStatus;
  driverLifecycle: DriverLifecycle;
  instanceId: string | null;
  setConfig: (c: PrimaryAgentRow | null) => void;
  setStatus: (s: PaStatus) => void;
  setDriverLifecycle: (d: DriverLifecycle) => void;
  setInstanceId: (id: string | null) => void;
  reset: () => void;
}

const INIT = { config: null, status: 'STOPPED' as PaStatus, driverLifecycle: 'idle' as DriverLifecycle, instanceId: null };

export const usePrimaryAgentStore = create<PrimaryAgentState>()((set) => ({
  ...INIT,
  setConfig: (c) => set({ config: c, status: c?.status ?? 'STOPPED' }),
  setStatus: (s) => set({ status: s }),
  setDriverLifecycle: (d) => set({ driverLifecycle: d }),
  setInstanceId: (id) => set({ instanceId: id }),
  reset: () => set(INIT),
}));

export const selectOnline = (s: PrimaryAgentState) => s.status === 'RUNNING';
export const selectPaConfig = (s: PrimaryAgentState) => s.config;
export const selectPaInstanceId = (s: PrimaryAgentState) => s.instanceId;
