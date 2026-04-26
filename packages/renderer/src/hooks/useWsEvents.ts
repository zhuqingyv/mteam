import { useEffect } from 'react';
import { createWsClient } from '../api/ws';
import { useMessageStore, useAgentStore, useNotificationStore, useWsStore } from '../store';

export function useWsEvents(): void {
  useEffect(() => {
    let client: ReturnType<typeof createWsClient> | null = null;
    try {
      client = createWsClient('local');
      useWsStore.getState().setClient(client);
      client.onEvent((e: { type: string; [k: string]: unknown }) => {
        const t = e.type;
        if (t === 'turn.block_updated') {
          const b = e.block as { blockId?: string; type?: string; content?: string } | undefined;
          if (!b?.blockId || b.type !== 'text') return;
          const msg = { id: b.blockId, role: 'agent' as const, content: b.content ?? '', time: String(e.ts ?? '') };
          const ms = useMessageStore.getState();
          if (ms.messages.some((m) => m.id === msg.id)) ms.replaceMessage(msg.id, msg);
          else ms.addMessage(msg);
        } else if (t === 'instance.activated' && typeof e.instanceId === 'string') {
          useAgentStore.getState().setActiveAgent(e.instanceId);
        } else if (t === 'notification.delivered') {
          useNotificationStore.getState().push({
            id: String(e.eventId ?? e.sourceEventId ?? Date.now()),
            title: String(e.sourceEventType ?? 'notification'),
            message: '', time: String(e.ts ?? ''),
          });
        } else if (t === 'comm.message_sent' || t === 'comm.message_received') {
          const ms = useMessageStore.getState();
          const id = String(e.messageId ?? e.eventId ?? Date.now());
          if (!ms.messages.some((m) => m.id === id)) {
            ms.addMessage({ id, role: 'agent', content: '', time: String(e.ts ?? '') });
          }
        }
      });
      client.subscribe('global');
      const hb = setInterval(() => client?.ping(), 30_000);
      return () => { clearInterval(hb); useWsStore.getState().setClient(null); client?.close(); };
    } catch {
      return () => { useWsStore.getState().setClient(null); client?.close(); };
    }
  }, []);
}
