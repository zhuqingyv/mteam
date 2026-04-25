import { create } from 'zustand';

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface TaskState {
  tasks: Task[];
  setTasks: (list: Task[]) => void;
  updateStatus: (id: string, status: Task['status']) => void;
}

export const useTaskStore = create<TaskState>()((set) => ({
  tasks: [],
  setTasks: (list) => set({ tasks: list }),
  updateStatus: (id, status) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
}));

export const selectTasks = (s: TaskState) => s.tasks;
export const selectSetTasks = (s: TaskState) => s.setTasks;
export const selectUpdateTaskStatus = (s: TaskState) => s.updateStatus;
