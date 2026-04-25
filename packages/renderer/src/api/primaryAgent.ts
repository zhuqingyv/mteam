// Primary Agent —— /api/panel/primary-agent* facade。

import { panelGet, panelPost, type ApiResult } from './client';

export interface PrimaryAgentRow {
  id?: string;
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  status?: string;
}

export function getPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow | null>> {
  return panelGet<PrimaryAgentRow | null>('/primary-agent');
}

export function startPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/start');
}

export function stopPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/stop');
}
