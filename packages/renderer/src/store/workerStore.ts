import { create } from 'zustand';
import type { WorkerView, WorkersStatsResponse } from '../api/ws-protocol';

// 数字员工 store —— workers-api.md 全 WS 数据源。
//
// - setAll：首屏 get_workers_response 整体落盘。
// - upsertByName：worker.status_changed 推送时按 name upsert status/instanceCount/teams；
//   workers-api.md 约定其它字段（role/description/persona/avatar/mcps/lastActivity）不在推送口径，保持既有值。
// - removeByName：template.deleted 时前端自行清缓存（worker-status subscriber 不 emit 删除事件）。

interface WorkerStatusPatch {
  name: string;
  status: WorkerView['status'];
  instanceCount: number;
  teams: string[];
}

interface WorkerState {
  workers: WorkerView[];
  stats: WorkersStatsResponse;
  loading: boolean;
  lastLoadedAt: number | null;
  setAll: (workers: WorkerView[], stats: WorkersStatsResponse) => void;
  setLoading: (loading: boolean) => void;
  upsertByName: (patch: WorkerStatusPatch) => void;
  removeByName: (name: string) => void;
}

function computeStats(workers: WorkerView[]): WorkersStatsResponse {
  let online = 0;
  let idle = 0;
  let offline = 0;
  for (const w of workers) {
    if (w.status === 'online') online += 1;
    else if (w.status === 'idle') idle += 1;
    else offline += 1;
  }
  return { total: workers.length, online, idle, offline };
}

export const useWorkerStore = create<WorkerState>()((set) => ({
  workers: [],
  stats: { total: 0, online: 0, idle: 0, offline: 0 },
  loading: false,
  lastLoadedAt: null,
  setAll: (workers, stats) => set({ workers, stats, loading: false, lastLoadedAt: Date.now() }),
  setLoading: (loading) => set({ loading }),
  upsertByName: (patch) => set((s) => {
    const idx = s.workers.findIndex((w) => w.name === patch.name);
    if (idx === -1) {
      // 新员工首次推送：补占位骨架（role/description/avatar/mcps 走 get_workers 拉全量覆盖），
      // 让 roles 窗口无需关窗重开就能看到新卡。
      const fresh: WorkerView = {
        name: patch.name,
        role: '',
        description: null,
        persona: null,
        avatar: null,
        mcps: [],
        status: patch.status,
        instanceCount: patch.instanceCount,
        teams: patch.teams,
        lastActivity: null,
      };
      const next = [...s.workers, fresh];
      return { workers: next, stats: computeStats(next) };
    }
    const existing = s.workers[idx];
    if (
      existing.status === patch.status
      && existing.instanceCount === patch.instanceCount
      && existing.teams.length === patch.teams.length
      && existing.teams.every((t, i) => t === patch.teams[i])
    ) {
      return s;
    }
    const next = s.workers.slice();
    next[idx] = {
      ...existing,
      status: patch.status,
      instanceCount: patch.instanceCount,
      teams: patch.teams,
    };
    return { workers: next, stats: computeStats(next) };
  }),
  removeByName: (name) => set((s) => {
    if (!s.workers.some((w) => w.name === name)) return s;
    const next = s.workers.filter((w) => w.name !== name);
    return { workers: next, stats: computeStats(next) };
  }),
}));

export const selectWorkers = (s: WorkerState) => s.workers;
export const selectWorkersStats = (s: WorkerState) => s.stats;
export const selectWorkersLoading = (s: WorkerState) => s.loading;
