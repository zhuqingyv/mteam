import { useEffect } from 'react';
import { createWsClient } from '../api/ws';
import { useWsStore } from '../store';
import {
  handlePrimaryAgentEvent,
  handleDriverEvent,
  handleInstanceEvent,
  handleTurnEvent,
  handleTeamEvent,
  handleOtherEvent,
} from './wsEventHandlers';

export function useWsEvents(): void {
  useEffect(() => {
    let client: ReturnType<typeof createWsClient> | null = null;
    try {
      client = createWsClient('local');
      useWsStore.getState().setClient(client);
      client.onEvent((e: { type: string; [k: string]: unknown }) => {
        const t = e.type;
        if (t.startsWith('primary_agent.')) handlePrimaryAgentEvent(t, e);
        else if (t.startsWith('driver.')) handleDriverEvent(t, e);
        else if (t.startsWith('instance.')) handleInstanceEvent(t, e);
        else if (t.startsWith('turn.')) handleTurnEvent(t, e);
        else if (t.startsWith('team.')) handleTeamEvent(t, e);
        else handleOtherEvent(t, e);
      });
      client.subscribe('global');
      const hb = setInterval(() => client?.ping(), 30_000);
      return () => { clearInterval(hb); useWsStore.getState().setClient(null); client?.close(); };
    } catch {
      return () => { useWsStore.getState().setClient(null); client?.close(); };
    }
  }, []);
}
