import { API_BASE } from './client';

export interface WsClient {
  send: (msg: object) => void;
  subscribe: (scope: string, id?: string) => void;
  unsubscribe: (scope: string, id?: string) => void;
  prompt: (instanceId: string, text: string, requestId?: string) => void;
  ping: () => void;
  close: () => void;
  onEvent: (handler: (event: any) => void) => void;
  onAck: (handler: (ack: any) => void) => void;
  onError: (handler: (err: any) => void) => void;
  readyState: () => number;
}

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

  function connect() {
    if (disposed) return;
    ws = new WebSocket(wsUrl(userId));
    ws.onmessage = ({ data }: MessageEvent) => {
      try {
        const m = JSON.parse(data);
        if (m.type === 'event') { if (m.id) lastMsgId = m.id; onEv?.(m.event); }
        else if (m.type === 'gap-replay') { for (const it of m.items ?? []) { if (it.id) lastMsgId = it.id; onEv?.(it.event); } }
        else if (m.type === 'ack') onAk?.(m);
        else if (m.type === 'error') onEr?.(m);
      } catch { /* bad json */ }
    };
    ws.onclose = () => { ws = null; if (!disposed) timer = setTimeout(connect, 3000); };
    ws.onerror = () => {};
  }
  connect();

  const send = (msg: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  return {
    send,
    subscribe(scope, id?) {
      const m: Record<string, unknown> = { op: 'subscribe', scope };
      if (id) m.id = id;
      if (lastMsgId) m.lastMsgId = lastMsgId;
      send(m);
    },
    unsubscribe(scope, id?) {
      const m: Record<string, unknown> = { op: 'unsubscribe', scope };
      if (id) m.id = id;
      send(m);
    },
    prompt(instanceId, text, requestId?) {
      const m: Record<string, unknown> = { op: 'prompt', instanceId, text };
      if (requestId) m.requestId = requestId;
      send(m);
    },
    ping: () => send({ op: 'ping' }),
    close() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { ws?.close(); } catch { /* */ }
      ws = null;
    },
    onEvent: (h) => { onEv = h; },
    onAck: (h) => { onAk = h; },
    onError: (h) => { onEr = h; },
    readyState: () => ws?.readyState ?? WebSocket.CLOSED,
  };
}
