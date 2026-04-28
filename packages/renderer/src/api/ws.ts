// WsClient 实现 —— 建连、心跳、断线重连、订阅维护、上行/下行分流。
// 类型声明在 ./ws-protocol.ts。

import { API_BASE } from './client';
import type {
  SnapshotMessage,
  TurnsResponseMessage,
  TurnHistoryResponseMessage,
  WorkersResponseMessage,
  WsClient,
} from './ws-protocol';

export type {
  SnapshotMessage,
  ConfigurePrimaryAgentBody,
  TurnsResponseMessage,
  TurnHistoryResponseMessage,
  WorkersResponseMessage,
  WorkerView,
  WorkerStatus,
  WorkersStatsResponse,
  GetTurnHistoryParams,
  WsClient,
} from './ws-protocol';

function wsUrl(userId: string): string {
  const base = API_BASE.replace(/^http(s?):\/\//, 'ws$1://');
  return `${base}/ws/events?userId=${encodeURIComponent(userId)}`;
}

export function createWsClient(userId = 'local'): WsClient {
  let ws: WebSocket | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastMsgId: string | undefined;
  let onEv: ((e: any) => void) | null = null;
  let onAk: ((a: any) => void) | null = null;
  let onEr: ((e: any) => void) | null = null;
  let onSn: ((s: SnapshotMessage) => void) | null = null;
  let onTr: ((m: TurnsResponseMessage) => void) | null = null;
  let onTh: ((m: TurnHistoryResponseMessage) => void) | null = null;
  let onWr: ((m: WorkersResponseMessage) => void) | null = null;
  let onRc: (() => void) | null = null;
  // 建连期的出站 buffer：subscribe/prompt 可能在 OPEN 之前就被调用。
  let pending: object[] = [];
  // snapshot 可能在 onSnapshot handler 注册前就到，注册时 flush。
  let pendingSnapshot: SnapshotMessage | null = null;
  // 断线重连时 onopen 里自动重发订阅，避免 pending 队列已 flush 造成漏订。
  const activeSubs = new Map<string, { scope: string; id?: string }>();
  const subKey = (scope: string, id?: string) => `${scope}:${id ?? ''}`;
  let hasConnectedOnce = false;

  function connect() {
    if (disposed) return;
    const isReconnect = hasConnectedOnce;
    ws = new WebSocket(wsUrl(userId));
    ws.onopen = () => {
      hasConnectedOnce = true;
      // 重连时 activeSubs 里的订阅需要自动重发 —— 带上 lastMsgId 触发 gap-replay。
      if (isReconnect && activeSubs.size > 0) {
        for (const sub of activeSubs.values()) {
          const m: Record<string, unknown> = { op: 'subscribe', scope: sub.scope };
          if (sub.id) m.id = sub.id;
          if (lastMsgId) m.lastMsgId = lastMsgId;
          try { ws?.send(JSON.stringify(m)); } catch { /* closed */ }
        }
      }
      const flush = pending;
      pending = [];
      for (const msg of flush) {
        try { ws?.send(JSON.stringify(msg)); } catch { /* closed */ }
      }
      if (isReconnect) {
        try { onRc?.(); } catch { /* handler error */ }
      }
    };
    ws.onmessage = ({ data }: MessageEvent) => {
      try {
        const m = JSON.parse(data);
        if (m.type === 'snapshot') {
          if (onSn) onSn(m as SnapshotMessage);
          else pendingSnapshot = m as SnapshotMessage;
        } else if (m.type === 'event') {
          if (m.id) lastMsgId = m.id;
          onEv?.(m.event);
        }
        else if (m.type === 'gap-replay') { for (const it of m.items ?? []) { if (it.id) lastMsgId = it.id; onEv?.(it.event); } }
        else if (m.type === 'ack') onAk?.(m);
        else if (m.type === 'error') onEr?.(m);
        else if (m.type === 'get_turns_response') onTr?.(m as TurnsResponseMessage);
        else if (m.type === 'get_turn_history_response') onTh?.(m as TurnHistoryResponseMessage);
        else if (m.type === 'get_workers_response') onWr?.(m as WorkersResponseMessage);
      } catch { /* bad json */ }
    };
    ws.onclose = () => { ws = null; if (!disposed) timer = setTimeout(connect, 3000); };
    ws.onerror = () => {};
  }
  connect();

  const send = (msg: object) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      // CONNECTING / 短暂断开期：缓冲到 onopen 再 flush。
      pending.push(msg);
    }
  };

  return {
    send,
    subscribe(scope, id?) {
      activeSubs.set(subKey(scope, id), { scope, id });
      const m: Record<string, unknown> = { op: 'subscribe', scope };
      if (id) m.id = id;
      if (lastMsgId) m.lastMsgId = lastMsgId;
      send(m);
    },
    unsubscribe(scope, id?) {
      activeSubs.delete(subKey(scope, id));
      const m: Record<string, unknown> = { op: 'unsubscribe', scope };
      if (id) m.id = id;
      send(m);
    },
    prompt(instanceId, text, requestId?) {
      const m: Record<string, unknown> = { op: 'prompt', instanceId, text };
      if (requestId) m.requestId = requestId;
      send(m);
    },
    cancelTurn(instanceId, requestId?) {
      const m: Record<string, unknown> = { op: 'cancel_turn', instanceId };
      if (requestId) m.requestId = requestId;
      send(m);
    },
    configurePrimaryAgent(body, requestId?) {
      const m: Record<string, unknown> = { op: 'configure_primary_agent', cliType: body.cliType };
      if (body.name !== undefined) m.name = body.name;
      if (body.systemPrompt !== undefined) m.systemPrompt = body.systemPrompt;
      if (requestId) m.requestId = requestId;
      send(m);
    },
    getTurns(driverId, limit?, requestId?) {
      const m: Record<string, unknown> = { op: 'get_turns', driverId };
      if (limit !== undefined) m.limit = limit;
      if (requestId) m.requestId = requestId;
      send(m);
    },
    getTurnHistory(driverId, params, requestId?) {
      const m: Record<string, unknown> = { op: 'get_turn_history', driverId };
      if (params.limit !== undefined) m.limit = params.limit;
      // beforeEndTs / beforeTurnId 必须成对；缺一方后端当首页。
      if (params.beforeEndTs !== undefined) m.beforeEndTs = params.beforeEndTs;
      if (params.beforeTurnId !== undefined) m.beforeTurnId = params.beforeTurnId;
      if (requestId) m.requestId = requestId;
      send(m);
    },
    getWorkers(requestId?) {
      const m: Record<string, unknown> = { op: 'get_workers' };
      if (requestId) m.requestId = requestId;
      send(m);
    },
    ping: () => send({ op: 'ping' }),
    close() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (ws) {
        // 显式解绑，避免 close 之后事件仍然跑到已释放的 handler 上。
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
      }
      try { ws?.close(); } catch { /* */ }
      ws = null;
      pending = [];
      pendingSnapshot = null;
      activeSubs.clear();
      onEv = null;
      onAk = null;
      onEr = null;
      onSn = null;
      onTr = null;
      onTh = null;
      onWr = null;
      onRc = null;
    },
    onEvent: (h) => { onEv = h; },
    onAck: (h) => { onAk = h; },
    onError: (h) => { onEr = h; },
    onSnapshot: (h) => {
      onSn = h;
      // 注册时立刻派一次 buffer 里的 snapshot，避免 Logo 启动时灰。
      if (pendingSnapshot) {
        const s = pendingSnapshot;
        pendingSnapshot = null;
        try { h(s); } catch { /* handler error */ }
      }
    },
    onTurnsResponse: (h) => { onTr = h; },
    onTurnHistoryResponse: (h) => { onTh = h; },
    onWorkersResponse: (h) => { onWr = h; },
    onReconnect: (h) => { onRc = h; },
    readyState: () => ws?.readyState ?? WebSocket.CLOSED,
  };
}
