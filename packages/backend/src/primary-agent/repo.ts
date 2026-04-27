import { randomUUID } from 'node:crypto';
import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from './types.js';
import type { McpToolVisibility } from '../domain/role-template.js';

interface Row {
  id: string;
  name: string;
  cli_type: string;
  system_prompt: string;
  mcp_config: string;
  status: string;
  sandbox: number;
  auto_approve: number;
  created_at: string;
  updated_at: string;
}

// lazy-prepared statements；closeDb 触发 hook 清空。
let selectStmt: Statement | null = null;
let insertStmt: Statement | null = null;
let updateConfigStmt: Statement | null = null;
let updateStatusStmt: Statement | null = null;

registerCloseHook(() => {
  selectStmt = null;
  insertStmt = null;
  updateConfigStmt = null;
  updateStatusStmt = null;
});

function getSelectStmt(): Statement {
  return (selectStmt ??= getDb().prepare(`SELECT * FROM primary_agent LIMIT 1`));
}
function getInsertStmt(): Statement {
  return (insertStmt ??= getDb().prepare(
    `INSERT INTO primary_agent
       (id, name, cli_type, system_prompt, mcp_config, status, sandbox, auto_approve, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'STOPPED', ?, ?, ?, ?)`,
  ));
}
function getUpdateConfigStmt(): Statement {
  return (updateConfigStmt ??= getDb().prepare(
    `UPDATE primary_agent
       SET name = ?, cli_type = ?, system_prompt = ?, mcp_config = ?,
           sandbox = ?, auto_approve = ?, updated_at = ?
     WHERE id = ?`,
  ));
}
function getUpdateStatusStmt(): Statement {
  return (updateStatusStmt ??= getDb().prepare(
    `UPDATE primary_agent SET status = ?, updated_at = ? WHERE id = ?`,
  ));
}

function rowToJson(row: Row): PrimaryAgentRow {
  return {
    id: row.id,
    name: row.name,
    cliType: row.cli_type,
    systemPrompt: row.system_prompt,
    mcpConfig: JSON.parse(row.mcp_config) as McpToolVisibility[],
    status: row.status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
    sandbox: row.sandbox === 1,
    autoApprove: row.auto_approve === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readRow(): PrimaryAgentRow | null {
  const row = getSelectStmt().get() as Row | undefined;
  return row ? rowToJson(row) : null;
}

export function upsertConfig(config: PrimaryAgentConfig): PrimaryAgentRow {
  const now = new Date().toISOString();
  const existing = readRow();
  const nextName = config.name ?? existing?.name ?? 'Primary';
  const nextCli = config.cliType ?? existing?.cliType ?? 'claude';
  const nextPrompt = config.systemPrompt ?? existing?.systemPrompt ?? '';
  const nextMcp = config.mcpConfig ?? existing?.mcpConfig ?? [];
  // 首次默认：主 Agent sandbox=1 / autoApprove=1；升级已有记录时保留旧值。
  const nextSandbox = config.sandbox ?? existing?.sandbox ?? true;
  const nextAutoApprove = config.autoApprove ?? existing?.autoApprove ?? true;

  if (!existing) {
    const id = randomUUID();
    getInsertStmt().run(
      id, nextName, nextCli, nextPrompt, JSON.stringify(nextMcp),
      nextSandbox ? 1 : 0, nextAutoApprove ? 1 : 0, now, now,
    );
  } else {
    getUpdateConfigStmt().run(
      nextName, nextCli, nextPrompt, JSON.stringify(nextMcp),
      nextSandbox ? 1 : 0, nextAutoApprove ? 1 : 0, now, existing.id,
    );
  }
  return readRow()!;
}

export function setStatus(id: string, status: 'STOPPED' | 'RUNNING'): void {
  getUpdateStatusStmt().run(status, new Date().toISOString(), id);
}
