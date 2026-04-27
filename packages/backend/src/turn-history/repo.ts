// turn_history DAO。只依赖 bun:sqlite（通过 db/connection）与 serializer。
// keyset 分页：排序键 (end_ts DESC, turn_id DESC)，配合 T1 复合索引。
// 同毫秒多条 Turn 不漂移：WHERE (end_ts < :be) OR (end_ts = :be AND turn_id < :bt)。
//
// prepare 提升：模块级 lazy init 缓存 prepared statement。
// closeDb 之后 handle 失效，用 registerCloseHook 重置缓存，下次 getDb 重新 prepare。

import { getDb, registerCloseHook } from '../db/connection.js';
import type { Statement } from 'bun:sqlite';
import type { Turn } from '../agent-driver/turn-types.js';
import { turnToRow, rowToTurn, type TurnHistoryRow } from './serializer.js';

export interface TurnCursor {
  endTs: string;
  turnId: string;
}

export interface ListRecentOpts {
  limit: number;
  before?: TurnCursor;
}

export interface ListRecentResult {
  items: Turn[];
  nextCursor: TurnCursor | null;
}

// lazy-prepared statements。closeDb 触发 hook 清空，下一次使用重新 prepare。
let insertStmt: Statement | null = null;
let listBeforeStmt: Statement | null = null;
let listAllStmt: Statement | null = null;
let countStmt: Statement | null = null;

registerCloseHook(() => {
  insertStmt = null;
  listBeforeStmt = null;
  listAllStmt = null;
  countStmt = null;
});

function getInsertStmt(): Statement {
  return (insertStmt ??= getDb().prepare(
    `INSERT OR IGNORE INTO turn_history
       (turn_id, driver_id, status, user_input, blocks, stop_reason, usage, start_ts, end_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ));
}

function getListBeforeStmt(): Statement {
  return (listBeforeStmt ??= getDb().prepare(
    `SELECT * FROM turn_history
       WHERE driver_id = ?
         AND (end_ts < ? OR (end_ts = ? AND turn_id < ?))
       ORDER BY end_ts DESC, turn_id DESC
       LIMIT ?`,
  ));
}

function getListAllStmt(): Statement {
  return (listAllStmt ??= getDb().prepare(
    `SELECT * FROM turn_history
       WHERE driver_id = ?
       ORDER BY end_ts DESC, turn_id DESC
       LIMIT ?`,
  ));
}

function getCountStmt(): Statement {
  return (countStmt ??= getDb().prepare(
    'SELECT COUNT(*) AS c FROM turn_history WHERE driver_id = ?',
  ));
}

// 首次 insert 成功；同 turn_id 再 insert 走 OR IGNORE，以先到为准。
// Why：turn.error + turn.completed 双发时，aggregator 已先发 completed，
// 不让后到的 error 轮次覆盖正式终态。
export function insertTurn(turn: Turn): void {
  const row = turnToRow(turn);
  getInsertStmt().run(
    row.turn_id,
    row.driver_id,
    row.status,
    row.user_input,
    row.blocks,
    row.stop_reason,
    row.usage,
    row.start_ts,
    row.end_ts,
  );
}

// 按 driverId 倒序翻页：返回 items + 下一页游标。
// nextCursor 为 null 表示"没下一页了"（本次返回条数 < limit 即判定尾页）。
export function listRecentByDriver(driverId: string, opts: ListRecentOpts): ListRecentResult {
  const { limit, before } = opts;
  const rows = (before
    ? getListBeforeStmt().all(driverId, before.endTs, before.endTs, before.turnId, limit)
    : getListAllStmt().all(driverId, limit)) as TurnHistoryRow[];

  const items = rows.map(rowToTurn);
  const last = rows[rows.length - 1];
  const nextCursor: TurnCursor | null =
    items.length < limit || !last
      ? null
      : { endTs: last.end_ts, turnId: last.turn_id };
  return { items, nextCursor };
}

export function countByDriver(driverId: string): number {
  const r = getCountStmt().get(driverId) as { c: number } | undefined;
  return r?.c ?? 0;
}
