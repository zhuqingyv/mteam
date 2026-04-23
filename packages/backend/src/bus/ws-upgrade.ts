// HTTP server 上挂 WebSocket upgrade：路径匹配 /ws/events 时接入 wsBroadcaster。
// 用 ws npm 包，其 WebSocket 接口（readyState / send / close / addEventListener）
// 天然匹配 ws.subscriber.ts 定义的 WsLike。
import type http from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { wsBroadcaster } from './index.js';

const WS_PATH = '/ws/events';

export function attachWsUpgrade(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    if (pathname !== WS_PATH) {
      (socket as Socket).destroy();
      return;
    }
    wss.handleUpgrade(req, socket as Socket, head, (ws: WebSocket) => {
      wsBroadcaster.addClient(ws);
    });
  });

  return wss;
}
