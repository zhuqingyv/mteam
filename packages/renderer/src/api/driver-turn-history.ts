// Driver Turn 冷历史翻页 —— /api/panel/driver/:driverId/turn-history。
// 对应 docs/frontend-api/turn-events.md §8：SQLite 持久化存储，进程重启不丢。
// 用于启动时恢复之前的对话记录，和 /turns（§4 热快照）分工互补。

import { panelGet, type ApiResult } from './client';
import type { Turn } from './driver-turns';

export interface TurnHistoryCursor {
  endTs: string;
  turnId: string;
}

export interface TurnHistoryPage {
  items: Turn[];
  hasMore: boolean;
  nextCursor: TurnHistoryCursor | null;
}

// GET /api/panel/driver/:driverId/turn-history?limit=10&beforeEndTs=...&beforeTurnId=...
// beforeEndTs 和 beforeTurnId 必须成对；缺一方等同首页。
export function getDriverTurnHistory(
  driverId: string,
  opts?: { limit?: number; before?: TurnHistoryCursor },
): Promise<ApiResult<TurnHistoryPage>> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.before) {
    params.set('beforeEndTs', opts.before.endTs);
    params.set('beforeTurnId', opts.before.turnId);
  }
  const qs = params.toString();
  const q = qs ? `?${qs}` : '';
  return panelGet<TurnHistoryPage>(`/driver/${encodeURIComponent(driverId)}/turn-history${q}`);
}
