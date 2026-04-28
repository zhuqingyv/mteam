// ACP 权限半自动模式的 pending map。
// driver.ts 在 permissionMode='manual' 时调 createPendingPermission → 推 WS 下行 →
// 等用户回应；前端 permission_response 上行到 handle-permission case 调 resolvePermission。
// 30s 无回应超时 reject；driver.stop 时 cancelAllPending 清理残留。
import type { WsLike } from './ws-handler.js';
import type { WsPermissionResponse, WsDownstream } from './protocol.js';

interface PendingPermission {
  resolve: (optionId: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingPermission>();

const DEFAULT_TIMEOUT_MS = 30_000;

/** 建 pending entry：30s 内未 resolve 则 reject('permission timeout')。 */
export function createPendingPermission(
  requestId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('permission timeout'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
  });
}

/** 用户回应到达 → resolve。找不到（已超时或重复）返回 false。 */
export function resolvePermission(requestId: string, optionId: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(optionId);
  return true;
}

/** driver.stop 或全局清理：所有 pending 统一 reject。 */
export function cancelAllPending(reason = 'instance stopped'): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

/** 测试用：查询当前 pending 数量。 */
export function pendingSize(): number {
  return pending.size;
}

/** WS 上行 permission_response 路由入口。resolvePermission 找不到仍 ack.ok=true（幂等）。 */
export function handlePermissionResponse(
  ws: WsLike,
  msg: WsPermissionResponse,
): void {
  resolvePermission(msg.requestId, msg.optionId);
  sendAck(ws, undefined, true);
}

function sendDown(ws: WsLike, msg: WsDownstream): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* 连接已断/序列化失败 */ }
}

function sendAck(ws: WsLike, requestId: string | undefined, ok: boolean): void {
  sendDown(ws, { type: 'ack', requestId: requestId ?? '', ok });
}
