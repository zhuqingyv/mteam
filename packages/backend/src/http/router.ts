// ⚠️ 主 Agent 相关接口禁止新增 HTTP 路由。主 Agent 对前端只走 WS（推送 + 主动请求历史数据）。
// 新查询需求请在 ws/protocol.ts 新增 op + ws/handle-*.ts 加 handler，不要走这里。
import type http from 'node:http';
import type { ApiResponse } from '../api/panel/role-templates.js';
import { notFound } from './http-utils.js';
import { handleRosterRoute } from './routes/roster.routes.js';
import { handleTeamsRoute } from './routes/teams.routes.js';
import { handleInstancesRoute } from './routes/instances.routes.js';
import { handleTemplatesRoute } from './routes/templates.routes.js';
import { handlePrimaryAgentRoute } from './routes/primary-agent.routes.js';
import { handleCliRoute } from './routes/cli.routes.js';
import { handleSessionsRoute } from './routes/sessions.routes.js';
import { handleMcpToolsRoute } from './routes/mcp-tools.routes.js';
import { handleMessagesRoute } from './routes/messages.routes.js';
import { handleAvatarsRoute } from './routes/avatars.routes.js';
import { handleActionItemsRoute } from './routes/action-items.routes.js';
import { handlePanelRoute } from './routes/panel.routes.js';

export async function route(req: http.IncomingMessage): Promise<ApiResponse> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '');

  // 逐个派发：命中就返回，不命中（null）继续下一个。
  const handlers: Array<() => Promise<ApiResponse | null> | ApiResponse | null> = [
    () => handlePanelRoute(req, pathname, method, query),
    () => handleRosterRoute(req, pathname, method, query),
    () => handleMcpToolsRoute(req, pathname, method, query),
    () => handleCliRoute(pathname, method),
    () => handlePrimaryAgentRoute(req, pathname, method),
    () => handleMessagesRoute(req, pathname, method, query),
    () => handleTeamsRoute(req, pathname, method),
    () => handleSessionsRoute(req, pathname, method),
    () => handleInstancesRoute(req, pathname, method, query),
    () => handleTemplatesRoute(req, pathname, method),
    () => handleAvatarsRoute(req, pathname, method),
    () => handleActionItemsRoute(req, pathname, method, query),
  ];

  for (const h of handlers) {
    const r = await h();
    if (r) return r;
  }
  return notFound;
}
