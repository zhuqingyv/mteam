// Panel facade: thin forwarding layer for the frontend dashboard.
// /api/panel/* → existing handlers. No business logic added.
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { handleListMcpStore } from '../../api/panel/mcp-store.js';
import { handleMessagesRoute } from './messages.routes.js';
import { handleMcpToolsRoute } from './mcp-tools.routes.js';
import { handleTeamsRoute } from './teams.routes.js';
import { handleInstancesRoute } from './instances.routes.js';
import { handleRosterRoute } from './roster.routes.js';
import { handleTemplatesRoute } from './templates.routes.js';
import { handlePrimaryAgentRoute } from './primary-agent.routes.js';
import { handleCliRoute } from './cli.routes.js';
import { handleAvatarsRoute } from './avatars.routes.js';
import { handleActionItemsRoute } from './action-items.routes.js';
import { handleWorkflowsRoute } from './workflows.routes.js';
import { notFound } from '../http-utils.js';

const PREFIX = '/api/panel';

export async function handlePanelRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (!pathname.startsWith(PREFIX + '/')) return null;

  const sub = pathname.slice(PREFIX.length); // e.g. "/teams"

  // Thin forwarders: /api/panel/teams* → /api/teams*, /api/panel/instances* → /api/role-instances*
  if (sub === '/teams' || sub.startsWith('/teams/')) {
    return (await handleTeamsRoute(req, '/api' + sub, method)) ?? notFound;
  }
  if (sub === '/instances' || sub.startsWith('/instances/')) {
    const forwarded = '/api/role-instances' + sub.slice('/instances'.length);
    return (await handleInstancesRoute(req, forwarded, method, query)) ?? notFound;
  }

  if (sub === '/roster' || sub.startsWith('/roster/')) {
    const forwarded = '/api/roster' + sub.slice('/roster'.length);
    return (await handleRosterRoute(req, forwarded, method, query)) ?? notFound;
  }
  if (sub === '/templates' || sub.startsWith('/templates/')) {
    const forwarded = '/api/role-templates' + sub.slice('/templates'.length);
    return (await handleTemplatesRoute(req, forwarded, method)) ?? notFound;
  }

  if (sub === '/primary-agent' || sub.startsWith('/primary-agent/')) {
    const forwarded = '/api/primary-agent' + sub.slice('/primary-agent'.length);
    return (await handlePrimaryAgentRoute(req, forwarded, method)) ?? notFound;
  }
  if (sub === '/cli' || sub.startsWith('/cli/')) {
    const forwarded = '/api/cli' + sub.slice('/cli'.length);
    return handleCliRoute(forwarded, method) ?? notFound;
  }
  if (sub === '/avatars' || sub.startsWith('/avatars/')) {
    const forwarded = '/api/avatars' + sub.slice('/avatars'.length);
    return (await handleAvatarsRoute(req, forwarded, method)) ?? notFound;
  }
  if (sub === '/action-items' || sub.startsWith('/action-items/')) {
    const forwarded = '/api/action-items' + sub.slice('/action-items'.length);
    return (await handleActionItemsRoute(req, forwarded, method, query)) ?? notFound;
  }
  if (sub === '/workflows' || sub.startsWith('/workflows/')) {
    const forwarded = '/api/workflows' + sub.slice('/workflows'.length);
    return (await handleWorkflowsRoute(req, forwarded, method)) ?? notFound;
  }

  // /api/panel/messages[/...] → /api/messages[/...]（method 不卡，由底层判定）。
  // 裸 /api/panel/messages 保留旧契约：映射到 /api/messages/send。
  if (sub === '/messages' || sub.startsWith('/messages/')) {
    const target = sub === '/messages' ? '/api/messages/send' : '/api' + sub;
    return (await handleMessagesRoute(req, target, method, query)) ?? notFound;
  }

  // /api/panel/mcp-tools[/...] → /api/mcp-tools[/...]；裸路径保留 /search 旧契约。
  if (sub === '/mcp-tools' || sub.startsWith('/mcp-tools/')) {
    const target = sub === '/mcp-tools' ? '/api/mcp-tools/search' : '/api' + sub;
    return (await handleMcpToolsRoute(req, target, method, query)) ?? notFound;
  }

  if (sub === '/mcp/tools' && method === 'GET') {
    return (await handleMcpToolsRoute(req, '/api/mcp-tools/search', method, query)) ?? notFound;
  }
  if (sub === '/mcp/store' && method === 'GET') return handleListMcpStore();

  return notFound;
}
