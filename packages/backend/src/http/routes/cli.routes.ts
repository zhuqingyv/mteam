// > 前端请走 /api/panel/cli/* 门面层，不要直接调用本接口。
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { handleListCli, handleRefreshCli } from '../../api/panel/cli.js';
import { notFound } from '../http-utils.js';

const CLI_PREFIX = '/api/cli';
const CLI_REFRESH = '/api/cli/refresh';

export function handleCliRoute(
  pathname: string,
  method: string,
): ApiResponse | Promise<ApiResponse> | null {
  if (pathname === CLI_REFRESH) {
    if (method === 'POST') return handleRefreshCli();
    return notFound;
  }
  if (pathname === CLI_PREFIX) {
    if (method === 'GET') return handleListCli();
    return notFound;
  }
  return null;
}
