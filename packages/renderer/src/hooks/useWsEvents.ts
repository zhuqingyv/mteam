import { useEffect } from 'react';
import { connectWs } from '../api/ws';
import { useMessageStore, useAgentStore, useNotificationStore } from '../store';

type WsEvent = { type: string; [k: string]: unknown };

export function useWsEvents(): void {
  useEffect(() => {
    let handle: { close(): void } | null = null;
    try {
      handle = connectWs((raw: unknown) => {
        const e = raw as WsEvent;
        if (e.type === 'turn.block_updated') {
          const b = e.block as { blockId?: string; type?: string; content?: string } | undefined;
          if (!b?.blockId || b.type !== 'text') return;
          const msg = { id: b.blockId, role: 'agent' as const, content: b.content ?? '', time: String(e.ts ?? '') };
          const s = useMessageStore.getState();
          if (s.messages.some((m) => m.id === msg.id)) s.replaceMessage(msg.id, msg);
          else s.addMessage(msg);
        } else if (e.type === 'instance.activated' && typeof e.instanceId === 'string') {
          useAgentStore.getState().setActiveAgent(e.instanceId);
        } else if (e.type === 'notification.delivered') {
          useNotificationStore.getState().push({
            id: String(e.eventId ?? e.sourceEventId ?? Date.now()),
            title: String(e.sourceEventType ?? 'notification'),
            message: '',
            time: String(e.ts ?? ''),
          });
        }
      });
    } catch (err) {
      console.warn('[useWsEvents] connect failed', err);
    }
    return () => handle?.close();
  }, []);
}
