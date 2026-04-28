// WS 协议类型声明 —— 对齐 docs/frontend-api/ws-protocol.md + turn-events.md。
// 从 ws.ts 拆出以满足单文件 ≤ 200 行门禁。

import type { Turn } from './driver-turns';
import type { TurnHistoryCursor } from './driver-turn-history';
import type { AgentState, PaMcpToolVisibility } from './primaryAgent';

export interface SnapshotMessage {
  primaryAgent?: {
    id: string;
    name: string;
    cliType: string;
    systemPrompt: string;
    mcpConfig: PaMcpToolVisibility[];
    status: 'RUNNING' | 'STOPPED';
    agentState?: AgentState;
    createdAt: string;
    updatedAt: string;
  } | null;
  [k: string]: unknown;
}

export interface ConfigurePrimaryAgentBody {
  cliType: string;
  name?: string;
  systemPrompt?: string;
}

export interface TurnsResponseMessage {
  type: 'get_turns_response';
  requestId: string;
  active: Turn | null;
  recent: Turn[];
}

export interface TurnHistoryResponseMessage {
  type: 'get_turn_history_response';
  requestId: string;
  items: Turn[];
  hasMore: boolean;
  nextCursor: TurnHistoryCursor | null;
}

export interface GetTurnHistoryParams {
  limit?: number;
  beforeEndTs?: string;
  beforeTurnId?: string;
}

// 对齐 docs/frontend-api/workers-api.md。数字员工只走 WS。
export type WorkerStatus = 'online' | 'idle' | 'offline';

export interface WorkerView {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  avatar: string | null;
  mcps: string[];
  status: WorkerStatus;
  instanceCount: number;
  teams: string[];
  lastActivity: { summary: string; at: string } | null;
}

export interface WorkersStatsResponse {
  total: number;
  online: number;
  idle: number;
  offline: number;
}

export interface WorkersResponseMessage {
  type: 'get_workers_response';
  requestId: string;
  workers: WorkerView[];
  stats: WorkersStatsResponse;
}

export interface WsClient {
  send: (msg: object) => void;
  subscribe: (scope: string, id?: string) => void;
  unsubscribe: (scope: string, id?: string) => void;
  prompt: (instanceId: string, text: string, requestId?: string) => void;
  cancelTurn: (instanceId: string, requestId?: string) => void;
  configurePrimaryAgent: (body: ConfigurePrimaryAgentBody, requestId?: string) => void;
  getTurns: (driverId: string, limit?: number, requestId?: string) => void;
  getTurnHistory: (driverId: string, params: GetTurnHistoryParams, requestId?: string) => void;
  getWorkers: (requestId?: string) => void;
  ping: () => void;
  close: () => void;
  onEvent: (handler: (event: any) => void) => void;
  onAck: (handler: (ack: any) => void) => void;
  onError: (handler: (err: any) => void) => void;
  onSnapshot: (handler: (snap: SnapshotMessage) => void) => void;
  onTurnsResponse: (handler: (msg: TurnsResponseMessage) => void) => void;
  onTurnHistoryResponse: (handler: (msg: TurnHistoryResponseMessage) => void) => void;
  onWorkersResponse: (handler: (msg: WorkersResponseMessage) => void) => void;
  // 重连成功回调 —— 首次连接不触发，仅 reconnect 后 onopen 触发；
  // 调用方用它补拉 WS turn 快照，订阅由 client 内部自动重发。
  onReconnect: (handler: () => void) => void;
  readyState: () => number;
}
