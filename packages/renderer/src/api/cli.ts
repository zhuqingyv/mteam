// CLI 扫描结果 —— /api/panel/cli facade。

import { panelGet, panelPost, type ApiResult } from './client';

export interface CliEntry {
  name: string;
  path: string;
  available: boolean;
}

export function listCli(): Promise<ApiResult<CliEntry[]>> {
  return panelGet<CliEntry[]>('/cli');
}

export function refreshCli(): Promise<ApiResult<CliEntry[]>> {
  return panelPost<CliEntry[]>('/cli/refresh');
}
