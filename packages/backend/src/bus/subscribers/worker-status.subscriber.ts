// 数字员工状态增量推送。
// 订阅 instance.* / driver.started|stopped / turn.started|completed，重算全量 worker 列表，
// 对比上次快照 → 差异条目 emit worker.status_changed。
//
// 设计权衡：
//  - 每事件全量重算：4 次 SQL，成员面板规模（≤ 几十模板）下廉价；避免维护 instanceId→template 反查缓存。
//  - 不订阅 turn.block_updated / driver.error：frequency 高且不改变 status 口径（在线/空闲/离线与是否有 ACTIVE 实例 + driverRegistry 命中挂钩，不看 turn 进度）。
//  - instance.deleted 时实例行已删，必须 emit 之后 subscriber 先走一遍重算（否则 deleted 的模板永远 stick 在旧快照）。
//  - 对比维度：status / instanceCount / teams（teams 去序比较）。lastActivity 变化不触发状态推送——它不是 status。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { getWorkerList } from '../../worker/aggregate.js';
import type { WorkerView } from '../../worker/types.js';

type StatusSnapshot = {
  status: WorkerView['status'];
  instanceCount: number;
  teamsKey: string; // 排序后拼接，O(1) 比较
};

const SOURCE = 'bus/worker-status';

export function subscribeWorkerStatus(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();
  const prev = new Map<string, StatusSnapshot>();

  const recompute = (): void => {
    try {
      const { workers } = getWorkerList();
      const seen = new Set<string>();
      for (const w of workers) {
        seen.add(w.name);
        const next: StatusSnapshot = {
          status: w.status,
          instanceCount: w.instanceCount,
          teamsKey: [...w.teams].sort().join(','),
        };
        const p = prev.get(w.name);
        if (!p || p.status !== next.status || p.instanceCount !== next.instanceCount || p.teamsKey !== next.teamsKey) {
          prev.set(w.name, next);
          eventBus.emit({
            ...makeBase('worker.status_changed', SOURCE),
            name: w.name,
            status: w.status,
            instanceCount: w.instanceCount,
            teams: w.teams,
          });
        }
      }
      // 模板被删（role_templates 行不在 workers 里了）→ 清理快照，不推事件
      // template.deleted 自己有白名单，前端收到后自行移除。
      for (const name of prev.keys()) {
        if (!seen.has(name)) prev.delete(name);
      }
    } catch (err) {
      process.stderr.write(
        `[worker-status] recompute failed: ${(err as Error).message}\n`,
      );
    }
  };

  // 所有触发事件都走同一份重算。
  const triggers = [
    'instance.created',
    'instance.activated',
    'instance.deleted',
    'driver.started',
    'driver.stopped',
    'turn.started',
    'turn.completed',
  ] as const;
  for (const t of triggers) {
    sub.add(eventBus.on(t).subscribe(() => recompute()));
  }

  return sub;
}
