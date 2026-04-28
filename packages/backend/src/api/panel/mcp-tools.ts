// GET /api/mcp-tools/search?instanceId=X&q=Y
// searchTools MCP 的回调接口：查 instance → template → availableMcps，列出每个 MCP 的
// 次屏工具（search 允许、surface 不含）并按 query 模糊匹配 name/description。
//
// 工具描述的权威来源：mteam 用 mcp/tools/registry.ts 的 ALL_TOOLS（带 leaderOnly）。
// 其他 MCP（mnemo 等）暂无注册表 —— search 仍能按工具名命中，description 留空。
// 待 Phase 4 扩 registry 为多 MCP 统一目录后再切换。
import { RoleInstance } from '../../domain/role-instance.js';
import { RoleTemplate } from '../../domain/role-template.js';
import type { McpToolVisibility } from '../../domain/role-template.js';
import { ALL_TOOLS } from '../../mcp/tools/registry.js';
import { readRow as readPrimaryRow } from '../../primary-agent/repo.js';
import type { ApiResponse } from './role-templates.js';

export interface SearchHit {
  mcpServer: string;
  toolName: string;
  description: string;
}

interface CatalogEntry {
  name: string;
  description: string;
  leaderOnly: boolean;
}

const errRes = (status: number, error: string): ApiResponse => ({
  status,
  body: { error },
});

function catalogFor(mcpName: string): CatalogEntry[] {
  if (mcpName === 'mteam') {
    return ALL_TOOLS.map((t) => ({
      name: t.schema.name,
      description: t.schema.description,
      leaderOnly: t.leaderOnly,
    }));
  }
  return [];
}

function visibilityAllows(list: string[] | '*', toolName: string): boolean {
  if (list === '*') return true;
  return list.includes(toolName);
}

// 对一条模板 MCP 配置，找"在 search 允许、在 surface 不展示"的工具。
// surface='*' 时视为全部在首屏 → 次屏为空。
function nonSurfaceTools(
  vis: McpToolVisibility,
  catalog: CatalogEntry[],
): CatalogEntry[] {
  if (vis.surface === '*') return [];
  return catalog.filter(
    (t) => visibilityAllows(vis.search, t.name) && !vis.surface.includes(t.name),
  );
}

function matches(entry: CatalogEntry, q: string): boolean {
  const lq = q.toLowerCase();
  if (entry.name.toLowerCase().includes(lq)) return true;
  if (entry.description.toLowerCase().includes(lq)) return true;
  return false;
}

export function handleSearchMcpTools(query: URLSearchParams): ApiResponse {
  const instanceId = query.get('instanceId') ?? '';
  const q = query.get('q') ?? '';
  if (!instanceId) return errRes(400, 'instanceId is required');
  if (!q) return errRes(400, 'q is required');

  const instance = RoleInstance.findById(instanceId);

  // Primary Agent 不在 role_instances 表里——它的 id 在 primary_agent 表。
  // 当 RoleInstance 找不到时退化到 primary_agent 查表；主 Agent 的 mcpConfig
  // 里通常不含 mteam（它用 mteam-primary），次屏工具集为空，直接返回空 hits。
  if (!instance) {
    const primary = readPrimaryRow();
    if (primary && primary.id === instanceId) {
      return searchForMcps(primary.mcpConfig, q, true);
    }
    return errRes(404, `instance '${instanceId}' not found`);
  }

  const template = RoleTemplate.findByName(instance.templateName);
  if (!template) {
    return errRes(404, `template '${instance.templateName}' not found`);
  }

  return searchForMcps(template.availableMcps, q, instance.isLeader);
}

function searchForMcps(
  mcps: McpToolVisibility[],
  q: string,
  isLeader: boolean,
): ApiResponse {
  const hits: SearchHit[] = [];
  for (const vis of mcps) {
    const catalog = catalogFor(vis.name);
    const roleFiltered = catalog.filter(
      (t) => !t.leaderOnly || isLeader,
    );
    const candidates = nonSurfaceTools(vis, roleFiltered);
    for (const entry of candidates) {
      if (matches(entry, q)) {
        hits.push({
          mcpServer: vis.name,
          toolName: entry.name,
          description: entry.description,
        });
      }
    }
  }
  return { status: 200, body: { hits } };
}
