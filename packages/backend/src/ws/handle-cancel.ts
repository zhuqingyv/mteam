// cancel_turn 上行处理。调 driver.interrupt()（ACP session/cancel），
// agent 端会以 stopReason='cancelled' resolve 当前 prompt，走正常 turn.completed 路径。
// 幂等：driver 不在 WORKING（已经 READY / STOPPED）直接 ack.ok=true，不报错。
import type { WsLike, WsHandlerDeps } from './ws-handler.js';
import type { WsCancelTurn, WsDownstream, WsErrorCode } from './protocol.js';

export function handleCancelTurn(
  ws: WsLike,
  deps: WsHandlerDeps,
  msg: WsCancelTurn,
): void {
  const driver = deps.driverRegistry.get(msg.instanceId);
  if (!driver) {
    return sendError(ws, 'not_found', `driver ${msg.instanceId} not found`);
  }
  // fire-and-forget：interrupt 发出 session/cancel notification 即返回；agent 端异步处理
  void driver.interrupt().catch((e) => {
    process.stderr.write(`[ws-handler] cancel_turn failed: ${(e as Error).message}\n`);
  });
  sendAck(ws, msg.requestId, true);
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
