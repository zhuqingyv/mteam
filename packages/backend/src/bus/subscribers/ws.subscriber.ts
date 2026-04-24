// WebSocket 广播器 —— 把 bus 事件推送到 /ws/events 的所有连接。
// 订阅用白名单而非 onPrefix，便于新增事件时明确决策"是否暴露给前端"。
// 推送前剥离 source / correlationId，避免泄漏内部字段。
import { Subscription } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { bus, EventBus } from '../events.js';
import type { BusEvent, BusEventType } from '../types.js';

// 前端全量订阅：25 种事件都推，前端按需过滤。
// 推送前剥离 source 和 correlationId（内部字段，前端无需）。
const WS_EVENT_TYPES: ReadonlySet<BusEventType> = new Set<BusEventType>([
  'instance.created',
  'instance.activated',
  'instance.offline_requested',
  'instance.deleted',
  'instance.session_registered',
  'pty.spawned',
  'pty.exited',
  'comm.registered',
  'comm.disconnected',
  'comm.message_sent',
  'comm.message_received',
  'template.created',
  'template.updated',
  'template.deleted',
  'mcp.installed',
  'mcp.uninstalled',
  'team.created',
  'team.disbanded',
  'team.member_joined',
  'team.member_left',
  'cli.available',
  'cli.unavailable',
  'primary_agent.started',
  'primary_agent.stopped',
  'primary_agent.configured',
]);

export function toWsPayload(e: BusEvent): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'source' || k === 'correlationId') continue;
    rest[k] = v;
  }
  return rest;
}

// 浏览器风格 WebSocket 接口（Bun 全局 WebSocket / ws npm 包 都兼容）。
// server.ts 集成时可用 ws 包或 Bun.serve 的 ServerWebSocket 适配层。
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

const WS_OPEN = 1;

export class WsBroadcaster {
  readonly clients = new Set<WsLike>();
  sub: Subscription | null = null;

  start(eventBus: EventBus = bus): void {
    if (this.sub) return;
    this.sub = eventBus.events$
      .pipe(
        filter((e) => WS_EVENT_TYPES.has(e.type)),
        map(toWsPayload),
      )
      .subscribe((payload) => {
        const json = JSON.stringify(payload);
        for (const ws of this.clients) {
          if (ws.readyState === WS_OPEN) {
            try {
              ws.send(json);
            } catch (err) {
              process.stderr.write(
                `[bus] ws send failed: ${(err as Error).message}\n`,
              );
            }
          }
        }
      });
  }

  addClient(ws: WsLike): void {
    this.clients.add(ws);
    const cleanup = (): void => {
      this.clients.delete(ws);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  stop(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
