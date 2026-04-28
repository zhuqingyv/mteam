export type WorkerStatus = 'online' | 'idle' | 'offline';

export interface WorkerLastActivity {
  summary: string;
  at: string;
}

export interface WorkerView {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  avatar: string | null;
  mcps: string[];
  status: WorkerStatus;
  instanceCount: number;
  teams: string[];
  lastActivity: WorkerLastActivity | null;
}

export interface WorkerStats {
  total: number;
  online: number;
  idle: number;
  offline: number;
}

export interface WorkerListResult {
  workers: WorkerView[];
  stats: WorkerStats;
}
