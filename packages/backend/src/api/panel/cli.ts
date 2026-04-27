// GET  /api/cli         → 读内存快照，不触发扫描
// POST /api/cli/refresh → 立即 refresh()（重新扫描 + diff + 可能发事件），返回最新快照
import { cliManager } from '../../cli-scanner/manager.js';
import type { ApiResponse } from './role-templates.js';

export function handleListCli(): ApiResponse {
  return { status: 200, body: cliManager.getAll() };
}

export async function handleRefreshCli(): Promise<ApiResponse> {
  return { status: 200, body: await cliManager.refresh() };
}
