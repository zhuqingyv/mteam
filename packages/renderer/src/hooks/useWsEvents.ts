import { useEffect } from 'react';
import { createWsClient } from '../api/ws';
import { useWsStore, usePrimaryAgentStore, useMessageStore, handleConfigureAck } from '../store';
import {
  handlePrimaryAgentEvent,
  handleDriverEvent,
  handleInstanceEvent,
  handleTurnEvent,
  handleTeamEvent,
  handleTemplateEvent,
  handleOtherEvent,
} from './wsEventHandlers';
import { applyTurnHistoryResponse, applyTurnsResponse } from './turnHydrator';
import { useInstanceSubscriptions } from './useInstanceSubscriptions';
import { useSubscribedInstanceIds } from './instanceSubRegistry';

// WS 连接生命周期 hook。
//
// 职责：
// - 建 WsClient、订阅 global scope；instance scope 订阅交给 useInstanceSubscriptions。
// - snapshot → primaryAgentStore（config / status / agentState / instanceId）。
// - WS 事件分流到 handle* 处理器。
// - instanceId 出现/变更 → 发 `get_turns` / `get_turn_history`（主 Agent 全 WS 数据源）。
// - 断线重连 → 补发 `get_turns` 覆盖中断期丢事件。
// - 15s 心跳 + pendingRequests 30s 超时回收。
//
// instance scope 订阅集合 = [primary, ...extra]；extra 由 addInstanceSub/removeInstanceSub
// 在 CanvasNode 展开时动态登记（见 instanceSubRegistry）。

export { addInstanceSub, removeInstanceSub } from './instanceSubRegistry';

export function useWsEvents(): void {
  // 订阅管理：primary 的 instanceId 由 store 驱动；额外 id 来自 registry。
  // useInstanceSubscriptions 自己做 diff + debounce，无需手动 subscribe/unsubscribe。
  const client = useWsStore((s) => s.client);
  const primaryInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const subscribedIds = useSubscribedInstanceIds(primaryInstanceId);
  useInstanceSubscriptions(subscribedIds, client);

  useEffect(() => {
    let activeClient: ReturnType<typeof createWsClient> | null = null;
    let unsubStore: (() => void) | null = null;

    // 每个 get_turns / get_turn_history 请求绑定 driverId —— 响应到达时校验，
    // instanceId 可能已切换；30s 自动回收防止 Map 无界增长。
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
      activeClient?.getTurns(driverId, 20, makeRequestId('turns', driverId));
    };
    const sendGetTurnHistory = (driverId: string) => {
      activeClient?.getTurnHistory(driverId, { limit: 20 }, makeRequestId('history', driverId));
    };

    try {
      activeClient = createWsClient('local');
      useWsStore.getState().setClient(activeClient);

      activeClient.onSnapshot((m) => {
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

      activeClient.onEvent((e: { type: string; [k: string]: unknown }) => {
        const t = e.type;
        if (t.startsWith('primary_agent.')) handlePrimaryAgentEvent(t, e);
        else if (t.startsWith('driver.')) handleDriverEvent(t, e);
        else if (t.startsWith('instance.')) handleInstanceEvent(t, e);
        else if (t.startsWith('turn.')) handleTurnEvent(t, e);
        else if (t.startsWith('team.')) handleTeamEvent(t, e);
        else if (t.startsWith('template.')) handleTemplateEvent(t, e);
        else handleOtherEvent(t, e);
      });

      activeClient.onAck((ack: { ok?: boolean; requestId?: string; reason?: string; error?: string; [k: string]: unknown }) => {
        const rid = typeof ack?.requestId === 'string' ? ack.requestId : undefined;
        const ok = ack?.ok !== false;
        const reason = ack?.reason ?? ack?.error;
        if (rid) handleConfigureAck(rid, ok, reason);
        if (!ok && !rid) usePrimaryAgentStore.setState({ lastError: reason ?? 'ws ack failed' });
      });

      activeClient.onError((err: { error?: string; message?: string; [k: string]: unknown }) => {
        usePrimaryAgentStore.setState({ lastError: err?.error ?? err?.message ?? 'ws error' });
      });

      activeClient.onTurnsResponse((msg) => {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        const driverId = pending?.driverId ?? usePrimaryAgentStore.getState().instanceId;
        if (!driverId) return;
        applyTurnsResponse(driverId, msg);
      });

      activeClient.onTurnHistoryResponse((msg) => {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        const currentId = usePrimaryAgentStore.getState().instanceId;
        if (pending && pending.driverId !== currentId) return;
        applyTurnHistoryResponse(msg);
      });

      activeClient.subscribe('global');

      // 首次已有 instanceId（snapshot 已到）→ 立即拉冷历史 + 热快照（全走 WS）。
      const initialId = usePrimaryAgentStore.getState().instanceId;
      if (initialId) {
        sendGetTurnHistory(initialId);
        sendGetTurns(initialId);
      }

      unsubStore = usePrimaryAgentStore.subscribe((s, prev) => {
        if (s.instanceId === prev.instanceId) return;
        // instance scope 的 sub/unsub 由顶层 useInstanceSubscriptions 接管；
        // 这里只补拉新 driver 的冷历史 + 热快照。
        if (s.instanceId) {
          sendGetTurnHistory(s.instanceId);
          sendGetTurns(s.instanceId);
        }
      });

      // 断线重连：subscribe 已由 ws.ts 自动重发；此处补拉 turn 热快照覆盖中断期事件。
      activeClient.onReconnect(() => {
        const id = usePrimaryAgentStore.getState().instanceId;
        if (id) sendGetTurns(id);
      });

      const hb = setInterval(() => activeClient?.ping(), 15_000);
      const sweep = setInterval(sweepPendingRequests, REQUEST_TTL_MS);
      return () => {
        clearInterval(hb);
        clearInterval(sweep);
        pendingRequests.clear();
        unsubStore?.();
        useWsStore.getState().setClient(null);
        // client 关闭代表 WS 生命周期结束（非自动重连期），清空用户消息队列，
        // 否则遗留的 pending text 会在下一次挂载时错乱。
        useMessageStore.getState().clearPending();
        activeClient?.close();
      };
    } catch {
      return () => {
        unsubStore?.();
        useWsStore.getState().setClient(null);
        useMessageStore.getState().clearPending();
        activeClient?.close();
      };
    }
  }, []);
}
