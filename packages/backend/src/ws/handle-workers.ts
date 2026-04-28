// get_workers / get_worker_activity 上行分支处理。
// 纯读侧：聚合 role_templates + role_instances + teams + turn_history；无副作用。
// 非法 range 返回 error 下行（bad_request），其它走 response。
import type { WsLike } from './ws-handler.js';
import type {
  WsDownstream, WsErrorCode,
  WsGetWorkers, WsGetWorkersResponse,
  WsGetWorkerActivity, WsGetWorkerActivityResponse,
} from './protocol.js';
import { getWorkerList } from '../worker/aggregate.js';
import { getWorkerActivity, parseRange } from '../worker/activity.js';

export function handleGetWorkers(ws: WsLike, msg: WsGetWorkers): void {
  try {
    const { workers, stats } = getWorkerList();
    const resp: WsGetWorkersResponse = {
      type: 'get_workers_response',
      requestId: msg.requestId ?? '',
      workers,
      stats,
    };
    sendDown(ws, resp);
  } catch (e) {
    sendError(ws, 'internal_error', (e as Error).message);
  }
}

export function handleGetWorkerActivity(ws: WsLike, msg: WsGetWorkerActivity): void {
  const range = parseRange(msg.range);
  if (!range) {
    return sendError(ws, 'bad_request', 'range must be one of: minute, hour, day, month, year');
  }
  try {
    const result = getWorkerActivity(range, msg.workerName ?? null);
    const resp: WsGetWorkerActivityResponse = {
      type: 'get_worker_activity_response',
      requestId: msg.requestId ?? '',
      range: result.range,
      workerName: result.workerName,
      dataPoints: result.dataPoints,
      total: result.total,
    };
    sendDown(ws, resp);
  } catch (e) {
    sendError(ws, 'internal_error', (e as Error).message);
  }
}

function sendDown(ws: WsLike, msg: WsDownstream): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* 连接已断/序列化失败 */ }
}

function sendError(ws: WsLike, code: WsErrorCode, message: string): void {
  sendDown(ws, { type: 'error', code, message });
}
