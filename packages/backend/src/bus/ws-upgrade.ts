// HTTP server 上挂 WebSocket upgrade：路径匹配 /ws/events 时接入 ws-handler + ws-broadcaster。
// 每条连接：解析 userId → 注册 UserSession → addConn → addClient → attachWsHandler → 推 snapshot。
// WS-Primary W2-B：建连后推一次 primary-agent snapshot，在订阅表/broadcaster 已就位后发送。
import type http from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SubscriptionManager } from '../ws/subscription-manager.js';
import type { WsBroadcaster } from '../ws/ws-broadcaster.js';
import type { UserSessionTracker } from '../ws/user-session.js';
import type { WsHandlerDeps } from '../ws/ws-handler.js';
import { attachWsHandler } from '../ws/ws-handler.js';
import { buildPrimaryAgentSnapshot } from '../ws/snapshot-builder.js';
import type { PrimaryAgentRow } from '../primary-agent/types.js';

const WS_PATH = '/ws/events';

export interface WsUpgradeDeps {
  subscriptionManager: SubscriptionManager;
  broadcaster: WsBroadcaster;
  userSessions: UserSessionTracker;
  handlerDeps: WsHandlerDeps;
  /** WS 建连时推 snapshot 用。未配置主 Agent 返回 null。 */
  getPrimaryAgentRow: () => PrimaryAgentRow | null;
  /** 主 Agent 内存中的 agentState。 */
  getAgentState?: () => 'idle' | 'thinking' | 'responding';
}

export function attachWsUpgrade(server: http.Server, deps: WsUpgradeDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    if (pathname !== WS_PATH) return void (socket as Socket).destroy();
    const userId = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '').get('userId') ?? 'local';
    wss.handleUpgrade(req, socket as Socket, head, (ws: WebSocket) => {
      const connectionId = randomUUID();
      deps.subscriptionManager.addConn(connectionId);
      deps.userSessions.register(connectionId, userId, ws);
      deps.broadcaster.addClient(connectionId, ws, { principal: { kind: 'user', userId } });
      attachWsHandler(ws, { connectionId, userId }, deps.handlerDeps);
      // 建连后立刻推 snapshot：保证在任何 event/ack 之前到达，前端 applySnapshot 先于 hydrate。
      try {
        const row = deps.getPrimaryAgentRow();
        const snap = buildPrimaryAgentSnapshot(row ? { ...row, agentState: deps.getAgentState?.() ?? 'idle' } : null);
        ws.send(JSON.stringify(snap));
      } catch { /* 推送失败吞掉，不影响 close 回调注册 */ }
      ws.on('close', () => {
        deps.broadcaster.removeClient(connectionId);
        deps.subscriptionManager.removeConn(connectionId);
        deps.userSessions.unregister(connectionId);
      });
    });
  });
  return wss;
}
