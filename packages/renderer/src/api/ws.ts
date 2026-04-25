// WebSocket 连接层。
//
// 服务端路径：/ws/events?userId=...（packages/backend/src/bus/ws-upgrade.ts）。
// 连接成功后按订阅收 bus 广播事件；每个事件 JSON 形状 [待 D2/D5]（服务端文档补完后再细化）。
// 本层只做：建连 → 事件解析 → 断线 3s 后自动重连 → 暴露 dispose 句柄。

import { API_BASE } from './client';

function wsBase(): string {
  // 把 http(s)://host:port 转成 ws(s)://host:port。
  if (API_BASE.startsWith('https://')) return 'wss://' + API_BASE.slice('https://'.length);
  if (API_BASE.startsWith('http://')) return 'ws://' + API_BASE.slice('http://'.length);
  return API_BASE; // 已经是 ws(s)://
}

export interface WsHandle {
  // 主动关闭：停止自动重连并关闭当前连接。
  close(): void;
  // 查当前底层 readyState（用于调试 / UI 状态灯）。
  readyState(): number;
}

export interface ConnectWsOptions {
  // 订阅者身份，默认 'local'，对应服务端 ws-upgrade 的 userId query。
  userId?: string;
  // 建连或重连成功时触发，UI 可借此回拉 Turn 快照补齐。
  onOpen?: () => void;
  // 连接异常（onerror）；不代表终止，后续仍会走 onclose + 自动重连。
  onError?: (e: Event) => void;
  // 重连间隔（ms），默认 3000。
  reconnectMs?: number;
}

// onMessage 拿到的是服务端广播的单个事件 JSON。解析失败会被静默丢弃并 warn。
export function connectWs(
  onMessage: (event: unknown) => void,
  options: ConnectWsOptions = {},
): WsHandle {
  const userId = options.userId ?? 'local';
  const reconnectMs = options.reconnectMs ?? 3000;

  let ws: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    if (disposed) return;
    const url = `${wsBase()}/ws/events?userId=${encodeURIComponent(userId)}`;
    ws = new WebSocket(url);
    ws.onopen = () => options.onOpen?.();
    ws.onmessage = (e: MessageEvent) => {
      try {
        const raw = typeof e.data === 'string' ? e.data : '';
        if (!raw) return;
        onMessage(JSON.parse(raw));
      } catch (err) {
        console.warn('[ws] bad message', err);
      }
    };
    ws.onerror = (e: Event) => options.onError?.(e);
    ws.onclose = () => {
      ws = null;
      if (disposed) return;
      reconnectTimer = setTimeout(open, reconnectMs);
    };
  }

  open();

  return {
    close(): void {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws !== null) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
    readyState(): number {
      return ws?.readyState ?? WebSocket.CLOSED;
    },
  };
}
