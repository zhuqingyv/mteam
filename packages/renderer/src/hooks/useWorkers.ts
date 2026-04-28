import { useEffect } from 'react';
import { useWsStore, useWorkerStore } from '../store';
import type { WorkersResponseMessage } from '../api/ws-protocol';

// 页面级 hook：首屏发 get_workers 拉全量，之后由 useWsEvents 里 handleWorkerEvent
// 监听 worker.status_changed 增量 upsert（见 wsEventHandlers.ts）。
//
// WS 连接/订阅/onReconnect 归 useWsEvents；这里只负责 get_workers 的 request/response，
// 用 requestId 自过滤避免串响应。

export function useWorkers(): void {
  const client = useWsStore((s) => s.client);

  useEffect(() => {
    if (!client) return;
    const setAll = useWorkerStore.getState().setAll;
    const setLoading = useWorkerStore.getState().setLoading;

    let activeRid = '';
    const fetchAll = () => {
      activeRid = `workers-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setLoading(true);
      client.getWorkers(activeRid);
    };

    client.onWorkersResponse((msg: WorkersResponseMessage) => {
      if (msg.requestId !== activeRid) return;
      setAll(msg.workers, msg.stats);
    });

    fetchAll();
  }, [client]);
}
