// 公共 agent lookup：按 instanceId 查 primary_agent / role_instances，拼 AgentLookup。
// Why 抽公共：WS prompt 和 HTTP /messages/send 都需要把 instanceId → displayName 供 envelope-builder，
//   两处内联会随表 schema 漂移，抽到这里保持单一事实源。
// Why 先查 primary_agent：主 Agent id 在 primary_agent 表，独立于 role_instances 体系；
//   只查 role_instances 会让主 Agent 的 ws prompt 永远 not_ready。
import type { AgentLookup } from './envelope-builder.js';
import { getDb } from '../db/connection.js';

/**
 * 按 instanceId 查找 agent 元信息。命中顺序：primary_agent → role_instances。
 * 返回 null 表示 instanceId 不存在。displayName 规则：role_instances 的 alias 非空优先，否则用 memberName；
 * primary_agent 直接用 name。
 */
export function lookupAgentByInstanceId(instanceId: string): AgentLookup | null {
  if (typeof instanceId !== 'string' || instanceId.length === 0) return null;

  const pa = getDb()
    .prepare(`SELECT id, name FROM primary_agent WHERE id = ?`)
    .get(instanceId) as { id: string; name: string } | undefined;
  if (pa) {
    return {
      instanceId: pa.id,
      memberName: pa.name,
      displayName: pa.name,
    };
  }

  const row = getDb()
    .prepare(`SELECT id, member_name, alias FROM role_instances WHERE id = ?`)
    .get(instanceId) as { id: string; member_name: string; alias: string | null } | undefined;
  if (!row) return null;
  return {
    instanceId: row.id,
    memberName: row.member_name,
    displayName: row.alias && row.alias.length > 0 ? row.alias : row.member_name,
  };
}
