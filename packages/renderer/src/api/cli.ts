// CLI 扫描结果 —— /api/panel/cli facade。

import { panelGet, panelPost, type ApiResult } from './client';

export interface CliInfo {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

/** @deprecated use CliInfo */
export type CliEntry = CliInfo;

export function listCli(): Promise<ApiResult<CliInfo[]>> {
  return panelGet<CliInfo[]>('/cli');
}

export function refreshCli(): Promise<ApiResult<CliInfo[]>> {
  return panelPost<CliInfo[]>('/cli/refresh');
}
