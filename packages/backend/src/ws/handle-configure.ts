// Phase WS-Primary · W2-A：configure_primary_agent 上行分支处理。
// 从 ws-handler.ts 抽出来压行数。fire-and-forget：立即 ack，
// 切 cliType 触发的 stop/start 链由 bus 事件广播推下去。
// configure/start 抛错时下行 internal_error。
import type { WsConfigurePrimaryAgent, WsDownstream, WsErrorCode } from './protocol.js';
import type { WsLike, WsHandlerDeps } from './ws-handler.js';
import type { PrimaryAgentConfig } from '../primary-agent/types.js';

export function handleConfigurePrimaryAgent(
  ws: WsLike,
  deps: WsHandlerDeps,
  msg: WsConfigurePrimaryAgent,
): void {
  sendAck(ws, msg.requestId, true);
  const config: PrimaryAgentConfig = { cliType: msg.cliType };
  if (msg.name !== undefined) config.name = msg.name;
  if (msg.systemPrompt !== undefined) config.systemPrompt = msg.systemPrompt;
  void deps.primaryAgent.configure(config).catch((e) => {
    sendError(ws, 'internal_error', (e as Error).message);
  });
}

function sendDown(ws: WsLike, msg: WsDownstream): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 连接已断 / 序列化失败（消息由本模块构造），吞掉
  }
}

function sendAck(ws: WsLike, requestId: string | undefined, ok: boolean): void {
  sendDown(ws, { type: 'ack', requestId: requestId ?? '', ok });
}

function sendError(ws: WsLike, code: WsErrorCode, message: string): void {
  sendDown(ws, { type: 'error', code, message });
}
