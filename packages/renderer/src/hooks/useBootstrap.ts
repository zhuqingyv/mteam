import { useEffect } from 'react';
import { listInstances } from '../api/instances';
import { useAgentStore } from '../store';

export function useBootstrap() {
  useEffect(() => {
    listInstances()
      .then((res) => {
        if (!res.ok || !res.data) return;
        useAgentStore.getState().setAgents(
          res.data.map((inst) => ({
            id: inst.id,
            name: inst.memberName || inst.templateName,
            status: inst.status === 'ACTIVE' ? 'running' as const : inst.status === 'PENDING' ? 'idle' as const : 'offline' as const,
          })),
        );
      })
      .catch(() => {});
  }, []);
}
