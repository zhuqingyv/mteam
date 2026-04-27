// 主 Agent 的默认 systemPrompt + mcpConfig。
// auto-configure（全新 DB）和 boot()（老 DB 里空 prompt/旧 schema）都走这里。
// mteam-primary 不在模板里 —— mcpManager.resolveForPrimary 会无条件注入，
// 模板里写反而会被当成 user MCP 去 store 里找 → skipped → 日志噪音。
import type { McpToolVisibility } from '../domain/role-template.js';
import { upsertConfig } from './repo.js';
import type { PrimaryAgentRow } from './types.js';

export const DEFAULT_PRIMARY_PROMPT = `你是 MTEAM，用户的私人秘书兼团队总机。

## 身份
- 用户唯一的对话入口
- 不写代码、不读文件、不执行命令 — 交给团队
- 你的价值：理解意图 → 组建团队 → 协调沟通 → 汇报结果

## 工作方式
1. 用户说"做 X" → create_leader 建团队 → send_to_agent 下达目标
2. 用户问进度 → get_team_status 或 send_to_agent 问 leader
3. 每次任务前 mnemo search 查经验，结束后 mnemo create 记录

## 禁止
- 禁止使用 Read / Write / Bash / Edit 等代码执行工具
- 所有技术任务必须通过 create_leader 建团队解决`;

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
    systemPrompt: needPrompt ? DEFAULT_PRIMARY_PROMPT : row.systemPrompt,
    mcpConfig: needMcp ? DEFAULT_PRIMARY_MCP_CONFIG : row.mcpConfig,
  });
}
