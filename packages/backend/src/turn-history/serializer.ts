// Turn <-> Row 纯函数序列化。无 DB/bus 依赖。
// row 字段形状与 turn_history.sql 列一一对应。

import type { Turn, TurnBlock, TurnStatus, UserInput, TurnUsage, StopReason } from '../agent-driver/turn-types.js';

export interface TurnHistoryRow {
  turn_id: string;
  driver_id: string;
  status: 'done' | 'error';
  user_input: string;
  blocks: string;
  stop_reason: string | null;
  usage: string | null;
  start_ts: string;
  end_ts: string;
}

// insertTurn 前的强校验：未终结态（active）不允许入库；endTs 必须存在。
function assertFinalized(turn: Turn): asserts turn is Turn & { status: 'done' | 'error'; endTs: string } {
  if (turn.status === 'active') {
    throw new Error(`[turn-history] cannot serialize active turn ${turn.turnId}`);
  }
  if (!turn.endTs) {
    throw new Error(`[turn-history] finalized turn ${turn.turnId} missing endTs`);
  }
}

export function turnToRow(turn: Turn): TurnHistoryRow {
  assertFinalized(turn);
  return {
    turn_id: turn.turnId,
    driver_id: turn.driverId,
    status: turn.status,
    user_input: JSON.stringify(turn.userInput),
    blocks: JSON.stringify(turn.blocks),
    stop_reason: turn.stopReason ?? null,
    usage: turn.usage ? JSON.stringify(turn.usage) : null,
    start_ts: turn.startTs,
    end_ts: turn.endTs,
  };
}

export function rowToTurn(row: TurnHistoryRow): Turn {
  const userInput = JSON.parse(row.user_input) as UserInput;
  const blocks = JSON.parse(row.blocks) as TurnBlock[];
  const usage = row.usage ? (JSON.parse(row.usage) as TurnUsage) : undefined;
  const turn: Turn = {
    turnId: row.turn_id,
    driverId: row.driver_id,
    status: row.status as TurnStatus,
    userInput,
    blocks,
    startTs: row.start_ts,
    endTs: row.end_ts,
  };
  if (row.stop_reason) turn.stopReason = row.stop_reason as StopReason;
  if (usage) turn.usage = usage;
  return turn;
}
