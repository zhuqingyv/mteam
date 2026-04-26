import { useEffect } from 'react';
import { getPrimaryAgent, configurePrimaryAgent, startPrimaryAgent } from '../api/primaryAgent';
import { listCli } from '../api/cli';
import { listInstances } from '../api/instances';
import { usePrimaryAgentStore } from '../store';

const DEFAULT_CONFIG = {
  name: 'Leader',
  cliType: 'claude',
  mcpConfig: [{ serverName: 'mteam', mode: 'all' as const }],
};

async function bootstrap() {
  const pa = usePrimaryAgentStore.getState();

  const res = await getPrimaryAgent().catch(() => null);
  let row = res?.ok ? res.data : null;

  if (!row) {
    const cfgRes = await configurePrimaryAgent(DEFAULT_CONFIG).catch(() => null);
    row = cfgRes?.ok ? cfgRes.data ?? null : null;
  }

  if (row) pa.setConfig(row);

  if (row && row.status === 'STOPPED') {
    const cliRes = await listCli().catch(() => null);
    const avail = cliRes?.ok && cliRes.data?.some((c) => c.name === (row!.cliType ?? 'claude') && c.available);
    if (avail) {
      const startRes = await startPrimaryAgent().catch(() => null);
      if (startRes?.ok && startRes.data) pa.setConfig(startRes.data);
    }
  }

  const instRes = await listInstances().catch(() => null);
  if (instRes?.ok && instRes.data) {
    const leader = instRes.data.find((i) => i.isLeader);
    if (leader) pa.setInstanceId(leader.id);
  }
}

export function useBootstrap() {
  useEffect(() => { bootstrap(); }, []);
}
