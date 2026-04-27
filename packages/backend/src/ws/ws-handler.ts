// Phase WS · W2-1：每条 WS 连接的上行消息主循环。
// on('message') → JSON.parse → isWsUpstream → switch(op) → 调子系统 / 回下行。
// ⚠️ 设计原则：前端主 Agent 只有 WS 一个数据源。查询类接口（快照/历史）也走 WS op，不加 HTTP。

import type { SubscriptionManager, ClientSubscription } from './subscription-manager.js';
import type { GapReplayDeps } from './gap-replayer.js';
import type { DriverRegistry } from '../agent-driver/registry.js';
import type { CommRegistry } from '../comm/registry.js';
import type { CommRouter } from '../comm/router.js';
import type { AgentLookup } from '../comm/envelope-builder.js';
import { buildEnvelope } from '../comm/envelope-builder.js';
import type {
  SubscriptionScope, WsDownstream, WsErrorCode,
  WsPrompt, WsSubscribe, WsUnsubscribe, WsUpstream,
} from './protocol.js';
import { isWsUpstream } from './protocol.js';
import { buildGapReplay } from './gap-replayer.js';
import { handleConfigurePrimaryAgent } from './handle-configure.js';
import { handleGetTurns, handleGetTurnHistory } from './handle-turns.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from '../primary-agent/types.js';
import type { Turn } from '../agent-driver/turn-types.js';
import type { ListRecentOpts, ListRecentResult } from '../turn-history/repo.js';

/** 只暴露 configure 一个方法，避免 handler 拿到 PrimaryAgent 的全部能力。 */
export interface WsPrimaryAgentAdapter {
  configure(config: PrimaryAgentConfig): Promise<PrimaryAgentRow>;
}

/** Turn 快照读侧。HTTP server 装配时点 getTurnAggregator 还返回 null（bootSubscribers 未跑）；
 *  必须传延迟访问器，运行时每次查询再调用。 */
export interface WsTurnAggregatorReader {
  getActive(driverId: string): Turn | null;
  getRecent(driverId: string, limit: number): Turn[];
}

export interface WsHandlerDeps {
  subscriptionManager: SubscriptionManager;
  driverRegistry: DriverRegistry;
  commRegistry: CommRegistry;
  gapReplayDeps: GapReplayDeps;
  commRouter: CommRouter;
  lookupAgent: (instanceId: string) => AgentLookup | null;
  primaryAgent: WsPrimaryAgentAdapter;
  /** 运行时获取 turn-aggregator；装配时点可能是 null（bootSubscribers 未跑），查询时才解析。 */
  getTurnAggregator: () => WsTurnAggregatorReader | null;
  /** Turn 冷历史翻页。直接注入 repo.listRecentByDriver，测试可替身。 */
  listTurnHistory: (driverId: string, opts: ListRecentOpts) => ListRecentResult;
}

export interface ConnectionContext {
  connectionId: string;
  userId: string;
}

export interface WsLike {
  send(data: string): void;
  on(type: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  close(): void;
}

export function attachWsHandler(
  ws: WsLike,
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
): void {
  ws.on('message', (...args: unknown[]) => {
    const raw = args[0];
    handleRaw(ws, ctx, deps, raw);
  });
}

function handleRaw(ws: WsLike, ctx: ConnectionContext, deps: WsHandlerDeps, raw: unknown): void {
  const text = toText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sendError(ws, 'bad_request', 'json parse failed');
  }
  if (!isWsUpstream(parsed)) {
    return sendError(ws, 'bad_request', 'schema invalid');
  }
  routeUpstream(ws, ctx, deps, parsed);
}

function routeUpstream(
  ws: WsLike,
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
  msg: WsUpstream,
): void {
  switch (msg.op) {
    case 'subscribe':
      return handleSubscribe(ws, ctx, deps, msg);
    case 'unsubscribe':
      return handleUnsubscribe(ws, ctx, deps, msg);
    case 'prompt':
      return void handlePrompt(ws, ctx, deps, msg);
    case 'ping':
      return sendDown(ws, { type: 'pong', ts: new Date().toISOString() });
    case 'configure_primary_agent':
      return handleConfigurePrimaryAgent(ws, deps, msg);
    case 'get_turns':
      return handleGetTurns(ws, deps, msg);
    case 'get_turn_history':
      return handleGetTurnHistory(ws, deps, msg);
    default: {
      const never: never = msg;
      void never;
      return sendError(ws, 'bad_request', 'unknown op');
    }
  }
}

function handleSubscribe(
  ws: WsLike,
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
  msg: WsSubscribe,
): void {
  // R1-10：user:<id> 只允许订阅自己。
  if (msg.scope === 'user' && msg.id !== ctx.userId) {
    return sendError(ws, 'forbidden', 'cannot subscribe other user');
  }

  const sub = toClientSubscription(msg.scope, msg.id);
  deps.subscriptionManager.subscribe(ctx.connectionId, sub);

  // 带 lastMsgId → gap-replay 在 ack 之前先推一条；顺序：gap-replay → ack。
  if (typeof msg.lastMsgId === 'string' && msg.lastMsgId.length > 0) {
    const replay = buildGapReplay(deps.gapReplayDeps, {
      lastMsgId: msg.lastMsgId,
      sub,
    });
    sendDown(ws, replay);
  }
  sendAck(ws, undefined, true);
}

function handleUnsubscribe(
  ws: WsLike,
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
  msg: WsUnsubscribe,
): void {
  deps.subscriptionManager.unsubscribe(
    ctx.connectionId,
    toClientSubscription(msg.scope, msg.id),
  );
  sendAck(ws, undefined, true);
}

async function handlePrompt(
  ws: WsLike,
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
  msg: WsPrompt,
): Promise<void> {
  // 目标存在 + driver READY 才允许 prompt。
  const lookup = deps.lookupAgent(msg.instanceId);
  if (!lookup) {
    return sendError(ws, 'not_ready', `driver ${msg.instanceId} not ready`);
  }
  const driver = deps.driverRegistry.get(msg.instanceId);
  if (!driver || !driver.isReady()) {
    return sendError(ws, 'not_ready', `driver ${msg.instanceId} not ready`);
  }

  // 用户和 agent 直接对话：不走 CommRouter/Envelope/通知行，直接注入对话上下文。
  // agent 间通信（send_msg）才走 CommRouter。
  void driver.prompt(msg.text).catch((e) => {
    process.stderr.write(`[ws-handler] prompt failed: ${(e as Error).message}\n`);
  });
  sendAck(ws, msg.requestId, true);
}

function toClientSubscription(scope: SubscriptionScope, id: string | undefined): ClientSubscription {
  if (scope === 'global') return { scope, id: null };
  return { scope, id: id ?? '' };
}

function toText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw && typeof raw === 'object' && 'toString' in raw) return String(raw);
  return '';
}

function sendDown(ws: WsLike, msg: WsDownstream): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* 连接已断/序列化失败 */ }
}

function sendAck(ws: WsLike, requestId: string | undefined, ok: boolean): void {
  sendDown(ws, { type: 'ack', requestId: requestId ?? '', ok });
}

function sendError(ws: WsLike, code: WsErrorCode, message: string): void {
  sendDown(ws, { type: 'error', code, message });
}
