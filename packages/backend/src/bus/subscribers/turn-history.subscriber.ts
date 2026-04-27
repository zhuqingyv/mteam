// T3 · turn-history 订阅器：订阅 turn.completed → filter(session-scope) → insertTurn。
//
// 独立模块，零 primary-agent 依赖。insertTurn 通过依赖注入（T2 的 repo.insertTurn）。
// aggregator 对 error 轮次会同时 emit turn.completed + turn.error，本订阅器仅消费
// turn.completed（turn 字段完整），turn.error 不再二次落库。
//
// 写库失败：stderr 打日志，不抛、不断流。TODO(F1): emit turn_history.write_failed
// bus 事件（见 docs/phase-turn-persist/TASK-LIST.md §F1）。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { isSessionScopeBlock } from '../../agent-driver/turn-types.js';
import type { Turn } from '../../agent-driver/turn-types.js';

export interface TurnHistorySubscriberDeps {
  insertTurn: (turn: Turn) => void;
}

export function subscribeTurnHistory(
  eventBus: EventBus = defaultBus,
  deps: TurnHistorySubscriberDeps,
): Subscription {
  return eventBus.on('turn.completed').subscribe((e) => {
    const t = e.turn;
    if (t.status !== 'done' && t.status !== 'error') return;
    const row: Turn = { ...t, blocks: t.blocks.filter((b) => !isSessionScopeBlock(b)) };
    try {
      deps.insertTurn(row);
    } catch (err) {
      process.stderr.write(
        `[turn-history] insert failed driverId=${t.driverId} turnId=${t.turnId}: ${(err as Error).message}\n`,
      );
    }
  });
}
