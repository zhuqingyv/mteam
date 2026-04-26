// Primary Agent —— /api/panel/primary-agent* facade。

import { panelGet, panelPost, type ApiResult } from './client';

export interface PaMcpToolVisibility {
  serverName: string;
  mode: 'all' | 'whitelist';
  tools?: string[];
}

export interface PrimaryAgentRow {
  id: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  mcpConfig: PaMcpToolVisibility[];
  status: 'STOPPED' | 'RUNNING';
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryAgentConfig {
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: PaMcpToolVisibility[];
}

export function getPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow | null>> {
  return panelGet<PrimaryAgentRow | null>('/primary-agent');
}

export function configurePrimaryAgent(
  body: PrimaryAgentConfig,
): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/config', body);
}

export function startPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/start');
}

export function stopPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/stop');
}
