import { useEffect } from 'react';
import { createWsClient } from '../api/ws';
import { useWsStore, usePrimaryAgentStore, handleConfigureAck } from '../store';
import {
  handlePrimaryAgentEvent,
  handleDriverEvent,
  handleInstanceEvent,
  handleTurnEvent,
  handleTeamEvent,
  handleOtherEvent,
} from './wsEventHandlers';
import { applyTurnHistoryResponse, applyTurnsResponse } from './turnHydrator';

// WS 连接生命周期 hook。
//
// 职责：
// - 建 WsClient、订阅 global + instance scope、按 instanceId 切换订阅。
// - snapshot → primaryAgentStore（config / status / agentState / instanceId）。
// - WS 事件分流到 handle* 处理器。
// - instanceId 出现/变更 → 发 `get_turns` / `get_turn_history`（主 Agent 全 WS 数据源）。
// - 断线重连 → 补发 `get_turns` 覆盖中断期丢事件。
// - 15s 心跳 + pendingRequests 30s 超时回收。

export function useWsEvents(): void {
  useEffect(() => {
    let client: ReturnType<typeof createWsClient> | null = null;
    let currentInstanceSub: string | null = null;
    let unsubStore: (() => void) | null = null;

    const syncInstanceSub = (nextId: string | null) => {
      if (!client) return;
      if (nextId === currentInstanceSub) return;
      if (currentInstanceSub) client.unsubscribe('instance', currentInstanceSub);
      if (nextId) client.subscribe('instance', nextId);
      currentInstanceSub = nextId;
    };

    // 记录每个 get_turns / get_turn_history 请求对应的 driverId，
    // 响应到达时校验 —— instanceId 可能已切换，旧响应不能污染新 driver 的视图。
    // 带 expiresAt：响应丢失时 30s 自动回收，防止 Map 无界增长。
    const REQUEST_TTL_MS = 30_000;
    const pendingRequests = new Map<
      string,
      { kind: 'turns' | 'history'; driverId: string; expiresAt: number }
    >();
    const makeRequestId = (kind: 'turns' | 'history', driverId: string): string => {
      const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pendingRequests.set(id, { kind, driverId, expiresAt: Date.now() + REQUEST_TTL_MS });
      return id;
    };
    const sweepPendingRequests = () => {
      const now = Date.now();
      for (const [id, entry] of pendingRequests) {
        if (entry.expiresAt <= now) pendingRequests.delete(id);
      }
    };
    const sendGetTurns = (driverId: string) => {
      if (!client) return;
      client.getTurns(driverId, 20, makeRequestId('turns', driverId));
    };
    const sendGetTurnHistory = (driverId: string) => {
      if (!client) return;
      client.getTurnHistory(driverId, { limit: 20 }, makeRequestId('history', driverId));
    };

    try {
      client = createWsClient('local');
      useWsStore.getState().setClient(client);

      client.onSnapshot((m) => {
        const pa = m.primaryAgent as import('../api/primaryAgent').PrimaryAgentRow | null | undefined;
        if (pa) {
          usePrimaryAgentStore.setState({
            config: pa,
            status: pa.status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
            agentState: pa.agentState ?? 'idle',
            instanceId: pa.id ?? null,
            lastError: null,
            driverLifecycle: 'idle',
          });
        }
      });

      client.onEvent((e: { type: string; [k: string]: unknown }) => {
        const t = e.type;
        if (t.startsWith('primary_agent.')) handlePrimaryAgentEvent(t, e);
        else if (t.startsWith('driver.')) handleDriverEvent(t, e);
        else if (t.startsWith('instance.')) handleInstanceEvent(t, e);
        else if (t.startsWith('turn.')) handleTurnEvent(t, e);
        else if (t.startsWith('team.')) handleTeamEvent(t, e);
        else handleOtherEvent(t, e);
      });

      client.onAck((ack: { ok?: boolean; requestId?: string; reason?: string; error?: string; [k: string]: unknown }) => {
        const rid = typeof ack?.requestId === 'string' ? ack.requestId : undefined;
        const ok = ack?.ok !== false;
        const reason = ack?.reason ?? ack?.error;
        if (rid) handleConfigureAck(rid, ok, reason);
        if (!ok && !rid) usePrimaryAgentStore.setState({ lastError: reason ?? 'ws ack failed' });
      });

      client.onError((err: { error?: string; message?: string; [k: string]: unknown }) => {
        usePrimaryAgentStore.setState({ lastError: err?.error ?? err?.message ?? 'ws error' });
      });

      client.onTurnsResponse((msg) => {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        const driverId = pending?.driverId ?? usePrimaryAgentStore.getState().instanceId;
        if (!driverId) return;
        applyTurnsResponse(driverId, msg);
      });

      client.onTurnHistoryResponse((msg) => {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        const currentId = usePrimaryAgentStore.getState().instanceId;
        if (pending && pending.driverId !== currentId) return;
        applyTurnHistoryResponse(msg);
      });


      client.subscribe('global');

      const initialId = usePrimaryAgentStore.getState().instanceId;
      syncInstanceSub(initialId);
      // 首次已有 instanceId（snapshot 已到）→ 立即拉冷历史 + 热快照（全走 WS）。
      if (initialId) {
        sendGetTurnHistory(initialId);
        sendGetTurns(initialId);
      }

      unsubStore = usePrimaryAgentStore.subscribe((s, prev) => {
        if (s.instanceId === prev.instanceId) return;
        syncInstanceSub(s.instanceId);
        // instanceId 从无到有 / 变更 → 拉新 driver 的历史与热快照。
        if (s.instanceId) {
          sendGetTurnHistory(s.instanceId);
          sendGetTurns(s.instanceId);
        }
      });

      // 断线重连：subscribe 已由 ws.ts 自动重发；此处补拉 turn 热快照覆盖中断期事件。
      client.onReconnect(() => {
        const id = usePrimaryAgentStore.getState().instanceId;
        if (id) sendGetTurns(id);
      });

      const hb = setInterval(() => client?.ping(), 15_000);
      const sweep = setInterval(sweepPendingRequests, REQUEST_TTL_MS);
      return () => {
        clearInterval(hb);
        clearInterval(sweep);
        pendingRequests.clear();
        unsubStore?.();
        if (client && currentInstanceSub) client.unsubscribe('instance', currentInstanceSub);
        currentInstanceSub = null;
        useWsStore.getState().setClient(null);
        client?.close();
      };
    } catch {
      return () => {
        unsubStore?.();
        useWsStore.getState().setClient(null);
        client?.close();
      };
    }
  }, []);
}
