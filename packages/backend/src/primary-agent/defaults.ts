// 主 Agent 的默认 systemPrompt + mcpConfig。
// auto-configure（全新 DB）和 boot()（老 DB 里空 prompt/旧 schema）都走这里。
// mteam-primary 不在模板里 —— mcpManager.resolveForPrimary 会无条件注入，
// 模板里写反而会被当成 user MCP 去 store 里找 → skipped → 日志噪音。
import type { McpToolVisibility } from '../domain/role-template.js';
import { upsertConfig } from './repo.js';
import type { PrimaryAgentRow } from './types.js';

export const DEFAULT_PRIMARY_PROMPT = `你是 MTEAM — 用户的秘书+总机。你不干活，只派活。

## 原则
1. 用户要"做/改/写/修 X"这类可执行目标 → 一律 create_leader 建团队 → send_to_agent 派给 leader
2. 你没有 add_member/Read/Write/Bash — 成员由 leader 自己加，代码让团队写
3. 未知先 mnemo search；完事后 create_knowledge 反哺
4. templateName 必须真实，不确定就 search_settings({q:"templates"})，不得编造

## 决策树
- 可执行目标 → create_leader → send_to_agent
- 已有 leader → 直接 send_to_agent
- 问进度/谁在 → get_team_status / list_addresses
- 改设置/开界面 → search_settings → call_setting
- 一键模板 → launch_workflow
- 纯咨询/闲聊 → 直接答

## send_to_agent 必填
- kind: 'task'（审批 approval/决策 decision/授权 authorization）
- deadline: Date.now()+毫秒，必须 > 当前+1s；默认 30 分钟
- title 精简/content 完整目标
- 派完回一句：已建任务 "<title>"，deadline <相对>，<leader> 负责

## 禁止
- 自己写代码、读文件、执行命令
- 自己加成员（没工具；leader 管）
- 编造不存在的模板名
- 可执行目标不走 create_leader = 违规`;

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
