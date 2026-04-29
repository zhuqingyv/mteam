// 主 Agent 的默认 systemPrompt + mcpConfig。
// auto-configure（全新 DB）和 boot()（老 DB 里空 prompt/旧 schema）都走这里。
// mteam-primary 不在模板里 —— mcpManager.resolveForPrimary 会无条件注入，
// 模板里写反而会被当成 user MCP 去 store 里找 → skipped → 日志噪音。
import type { McpToolVisibility } from '../domain/role-template.js';
import { upsertConfig } from './repo.js';
import type { PrimaryAgentRow } from './types.js';

export function buildPrimaryPrompt(name: string): string {
  return `你是 ${name}，用户的 AI 团队总监。所有 team leader 直接向你汇报。

一定永远思考用户真正的需求，不懂立刻问，不要为了完成眼下任务偏离真正的需求！！！

## 你是谁
- AI 团队最高权限的 AI 助理，直接服务对接用户
- 所有 leader 直接汇报于你，你统筹全局
- 非用户特殊要求，不亲力亲为，日常工作就是驱使 leader 工作
- 对用户说人话，不暴露任何技术细节和内部 id

## 怎么工作
- 需要干活 → 安排 leader 去做（create_leader + send_to_agent）
- 已有 leader → 直接派活（send_to_agent）
- 多人协作 → 安排一个 leader，让 leader 自己组团队
- 看进度 → get_team_status / list_addresses
- 改系统设置 → search_settings + call_setting
- 用 mnemo 记住重要的事，下次不重复踩坑`;
}

export const DEFAULT_PRIMARY_MCP_CONFIG: McpToolVisibility[] = [
  { name: 'mnemo', surface: '*', search: '*' },
];

// 旧 schema 识别：mcpConfig 里存在 serverName 字段（新 schema 只有 name）。
function hasLegacyMcpConfig(mcpConfig: unknown): boolean {
  if (!Array.isArray(mcpConfig)) return false;
  return mcpConfig.some((m) => {
    if (!m || typeof m !== 'object') return false;
    const rec = m as Record<string, unknown>;
    return typeof rec.serverName === 'string' && typeof rec.name !== 'string';
  });
}

// 老 DB 里主 Agent 可能是旧 schema（空 prompt / mcpConfig 旧 {serverName,mode}）。
// 开机时检测并就地修正，返回修正后的 row；若无需迁移返回 null。
export function maybeMigrateDefaults(row: PrimaryAgentRow): PrimaryAgentRow | null {
  const needPrompt = !row.systemPrompt || row.systemPrompt.trim() === '';
  const needMcp = hasLegacyMcpConfig(row.mcpConfig);
  if (!needPrompt && !needMcp) return null;
  return upsertConfig({
    name: row.name,
    cliType: row.cliType,
    systemPrompt: needPrompt ? buildPrimaryPrompt(row.name) : row.systemPrompt,
    mcpConfig: needMcp ? DEFAULT_PRIMARY_MCP_CONFIG : row.mcpConfig,
  });
}
