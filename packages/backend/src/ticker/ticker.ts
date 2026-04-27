import type { Ticker, TickerTask } from './types.js';

export function createTicker(): Ticker {
  const tasks = new Map<string, TickerTask>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function tick() {
    timer = null;
    const now = Date.now();
    for (const [id, task] of tasks) {
      if (now >= task.fireAt) {
        try {
          task.callback();
        } catch {
          /* 单任务炸不影响其他 */
        }
        if (task.repeat) {
          task.fireAt = Date.now() + task.repeat;
        } else {
          tasks.delete(id);
        }
      }
    }
    scheduleNext();
  }

  function scheduleNext() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (tasks.size === 0) return;
    let nearest = Infinity;
    for (const task of tasks.values()) {
      if (task.fireAt < nearest) nearest = task.fireAt;
    }
    const delay = Math.max(nearest - Date.now(), 0);
    timer = setTimeout(tick, delay);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }

  return {
    schedule(task: TickerTask) {
      tasks.set(task.id, { ...task });
      scheduleNext();
    },
    cancel(id: string) {
      tasks.delete(id);
      scheduleNext();
    },
    reschedule(id: string, newFireAt: number) {
      const task = tasks.get(id);
      if (task) {
        task.fireAt = newFireAt;
        scheduleNext();
      }
    },
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
      tasks.clear();
    },
    size() {
      return tasks.size;
    },
  };
}

export const globalTicker = createTicker();
