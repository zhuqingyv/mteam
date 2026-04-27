// Driver Turn 类型与快照接口。
//
// 类型对齐服务端 packages/backend/src/agent-driver/turn-types.ts 的 Turn / TurnBlock / TurnStatus，
// 前端只需要一个结构一致的本地声明，便于解耦、不跨包导入。
//
// 注意：主 Agent 热快照走 WS op `get_turns`（见 ws.ts getTurns），
// HTTP getDriverTurns 仅保留供调试/旧调用点使用。

import { panelGet, type ApiResult } from './client';

export type TurnStatus = 'active' | 'done' | 'error';

export interface TurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface UserInput {
  text: string;
  attachments?: unknown[];
  ts: string;
}

// 服务端 TurnBlock 是 thinking/text/tool_call/plan/usage/commands/mode/config/session_info 联合。
// 面板只需按 type 字段分发渲染，详细字段交由各 block 组件读取，这里保持松散。
export interface TurnBlock {
  type: string;
  [key: string]: unknown;
}

export interface Turn {
  turnId: string;
  driverId: string;
  status: TurnStatus;
  userInput: UserInput;
  blocks: TurnBlock[];
  stopReason?: string;
  usage?: TurnUsage;
  startTs: string;
  endTs?: string;
}

export interface DriverTurnsSnapshot {
  active: Turn | null;
  recent: Turn[];
}

// GET /api/panel/driver/:driverId/turns?limit=10
// 服务端语义：driver 从未跑过 / 无 active → active=null（不是 404）；
// recent 只含已关闭 Turn，按 endTs 降序；limit 默认 10、上限 50。
export function getDriverTurns(
  driverId: string,
  limit?: number,
): Promise<ApiResult<DriverTurnsSnapshot>> {
  const q = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
  return panelGet<DriverTurnsSnapshot>(`/driver/${encodeURIComponent(driverId)}/turns${q}`);
}
