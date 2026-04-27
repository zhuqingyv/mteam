// bus 侧 turn.* 事件形状。由 TurnAggregator（T-9 落地）产出，推给 ws-broadcaster / HTTP 快照。
//
// 设计权威：docs/phase-ws/turn-aggregator-design.md §2.4 / §5.1 / §5.7。
//
// 事件语义：
//   turn.started       —— driver.turn_start 时 emit；前端立即切「正在思考」loading 态
//   turn.block_updated —— 每次 block 有变更 emit 一次，block 为完整最新状态（非 delta）；
//                         前端按 blockId upsert，不存在则按 seq append
//   turn.completed     —— driver.turn_done / driver.stopped / driver.error 关闭 active Turn 时 emit
//   turn.error         —— driver.error 导致 active Turn 异常结束时 emit（与 completed 同时发）

import type { Turn, TurnBlock, UserInput } from '../agent-driver/turn-types.js';
import type { BusEventBase } from './types.js';

export interface TurnStartedEvent extends BusEventBase {
  type: 'turn.started';
  driverId: string;
  turnId: string;
  userInput: UserInput;
}

export interface TurnBlockUpdatedEvent extends BusEventBase {
  type: 'turn.block_updated';
  driverId: string;
  turnId: string;
  // = block.seq；冗余放外层方便路由过滤，不需要解包 block。
  seq: number;
  block: TurnBlock;
}

export interface TurnCompletedEvent extends BusEventBase {
  type: 'turn.completed';
  driverId: string;
  turnId: string;
  // 完整成交版本；前端收到后归档到本地 history。
  turn: Turn;
}

export interface TurnErrorEvent extends BusEventBase {
  type: 'turn.error';
  driverId: string;
  turnId: string;
  message: string;
}

export type TurnBusEvent =
  | TurnStartedEvent
  | TurnBlockUpdatedEvent
  | TurnCompletedEvent
  | TurnErrorEvent;

export type TurnBusEventType = TurnBusEvent['type'];
