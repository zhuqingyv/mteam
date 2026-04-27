// Phase WS-Turn-Readonly：get_turns / get_turn_history 上行分支处理。
// 从 ws-handler.ts 抽出来压行数。纯读侧：等价 HTTP /turns 和 /turn-history，
// 但直接推回下行，不走 HTTP。
//
// 设计原则（与 HTTP 路由保持一致）：
//   - get_turns：aggregator 未就位（bootSubscribers 未跑）→ 返回空快照，不报错
//   - get_turn_history：keyset 游标必须成对，缺一方当首页；limit 默认 10、上限 50
//   - driver 不存在 / 没历史 → items:[], hasMore:false；不区分 404
import type { WsLike, WsHandlerDeps } from './ws-handler.js';
import type {
  WsDownstream, WsErrorCode, WsGetTurnHistory, WsGetTurns,
  WsGetTurnHistoryResponse, WsGetTurnsResponse,
} from './protocol.js';
import type { TurnCursor } from '../turn-history/repo.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function handleGetTurns(
  ws: WsLike,
  deps: WsHandlerDeps,
  msg: WsGetTurns,
): void {
  const limit = clampLimit(msg.limit);
  const aggregator = deps.getTurnAggregator();
  // bootSubscribers 未跑 → 等价空快照（与 HTTP 路由 §4.8 S1 保持一致）。
  const active = aggregator ? aggregator.getActive(msg.driverId) : null;
  const recent = aggregator ? aggregator.getRecent(msg.driverId, limit) : [];
  const resp: WsGetTurnsResponse = {
    type: 'get_turns_response',
    requestId: msg.requestId ?? '',
    active,
    recent,
  };
  sendDown(ws, resp);
}

export function handleGetTurnHistory(
  ws: WsLike,
  deps: WsHandlerDeps,
  msg: WsGetTurnHistory,
): void {
  const limit = clampLimit(msg.limit);
  const before = toCursor(msg.beforeEndTs, msg.beforeTurnId);
  try {
    const { items, nextCursor } = deps.listTurnHistory(msg.driverId, { limit, before });
    const resp: WsGetTurnHistoryResponse = {
      type: 'get_turn_history_response',
      requestId: msg.requestId ?? '',
      items,
      hasMore: nextCursor !== null,
      nextCursor,
    };
    sendDown(ws, resp);
  } catch (e) {
    sendError(ws, 'internal_error', (e as Error).message);
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

function toCursor(endTs: string | undefined, turnId: string | undefined): TurnCursor | undefined {
  if (!endTs || !turnId) return undefined;
  return { endTs, turnId };
}

function sendDown(ws: WsLike, msg: WsDownstream): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* 连接已断/序列化失败 */ }
}

function sendError(ws: WsLike, code: WsErrorCode, message: string): void {
  sendDown(ws, { type: 'error', code, message });
}
