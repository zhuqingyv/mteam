// Phase WS · W1-A：WebSocket 上下行消息协议。
// 本文件是纯类型 + 类型守卫，不含运行时副作用。
// Phase WS-Primary · W1-A：新增 configure_primary_agent / snapshot，主 Agent 全走 WS。
// Phase WS-Turn-Readonly：新增 get_turns / get_turn_history，主 Agent 查询类接口迁移到 WS。
import type { PrimaryAgentRow } from '../primary-agent/types.js';
import type { Turn } from '../agent-driver/turn-types.js';
import type { TurnCursor } from '../turn-history/repo.js';

/** 订阅作用域。global=全局事件；其余三种按 id 过滤。 */
export type SubscriptionScope = 'global' | 'team' | 'instance' | 'user';

/** 下行错误码。对应 REGRESSION R1-5/R1-6/R1-10。 */
export type WsErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'not_ready'
  | 'internal_error';

/** bus 事件 → WS payload 的序列化结果（具体字段见 bus/types.ts）。 */
export type WsEventPayload = Record<string, unknown>;

// ----------------------------------------------------------------------------
// 上行消息（前端 → 后端）
// ----------------------------------------------------------------------------

export interface WsSubscribe {
  op: 'subscribe';
  scope: SubscriptionScope;
  id?: string;
  lastMsgId?: string;
}

export interface WsUnsubscribe {
  op: 'unsubscribe';
  scope: SubscriptionScope;
  id?: string;
}

export interface WsPrompt {
  op: 'prompt';
  instanceId: string;
  text: string;
  requestId?: string;
}

export interface WsPing {
  op: 'ping';
}

/** 配置主 Agent（切 cliType 触发重启）。协议层只收窄为非空 string，未知值由业务层拒。 */
export interface WsConfigurePrimaryAgent {
  op: 'configure_primary_agent';
  cliType: string;
  name?: string;
  systemPrompt?: string;
  requestId?: string;
}

/** 拉 driver 当前 Turn 快照（active + recent）。等价于旧 HTTP GET /api/panel/driver/:id/turns。 */
export interface WsGetTurns {
  op: 'get_turns';
  driverId: string;
  limit?: number;
  requestId?: string;
}

/** Turn 冷历史翻页。等价于旧 HTTP GET /api/panel/driver/:id/turn-history。keyset 游标成对，缺一方当首页。 */
export interface WsGetTurnHistory {
  op: 'get_turn_history';
  driverId: string;
  limit?: number;
  beforeEndTs?: string;
  beforeTurnId?: string;
  requestId?: string;
}

export type WsUpstream =
  | WsSubscribe
  | WsUnsubscribe
  | WsPrompt
  | WsPing
  | WsConfigurePrimaryAgent
  | WsGetTurns
  | WsGetTurnHistory;

// ----------------------------------------------------------------------------
// 下行消息（后端 → 前端）
// ----------------------------------------------------------------------------

export interface WsEventDown {
  type: 'event';
  id: string;
  event: WsEventPayload;
}

export interface WsGapReplay {
  type: 'gap-replay';
  items: Array<{ id: string; event: WsEventPayload }>;
  /** 本批次最新一条 id；超量时 = 最老一条 id 供续拉；无 gap 时 null。 */
  upTo: string | null;
}

export interface WsPong {
  type: 'pong';
  ts: string;
}

export interface WsAck {
  type: 'ack';
  requestId: string;
  ok: boolean;
  reason?: string;
}

export interface WsErrorDown {
  type: 'error';
  code: WsErrorCode;
  message: string;
}

/** 主 Agent 快照：每次 WS 建连推一次；载荷 = 完整 PrimaryAgentRow（与 GET /api/primary-agent 1:1）；未配置时 null。 */
export interface WsSnapshot {
  type: 'snapshot';
  primaryAgent: PrimaryAgentRow | null;
}

/** get_turns 的下行响应。driver 从未跑过 / 无 active → active=null。recent 按 endTs 降序。 */
export interface WsGetTurnsResponse {
  type: 'get_turns_response';
  requestId: string;
  active: Turn | null;
  recent: Turn[];
}

/** get_turn_history 的下行响应。nextCursor===null 即尾页。 */
export interface WsGetTurnHistoryResponse {
  type: 'get_turn_history_response';
  requestId: string;
  items: Turn[];
  hasMore: boolean;
  nextCursor: TurnCursor | null;
}

export type WsDownstream =
  | WsEventDown
  | WsGapReplay
  | WsPong
  | WsAck
  | WsErrorDown
  | WsSnapshot
  | WsGetTurnsResponse
  | WsGetTurnHistoryResponse;

// ----------------------------------------------------------------------------
// 类型守卫 —— 实现在 protocol-guards.ts；re-export 保兼容旧 import 路径
// ----------------------------------------------------------------------------

export { isWsUpstream } from './protocol-guards.js';
