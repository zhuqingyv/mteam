import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from './types.js';
import type { McpToolVisibility } from '../domain/role-template.js';

interface Row {
  id: string;
  name: string;
  cli_type: string;
  system_prompt: string;
  mcp_config: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToJson(row: Row): PrimaryAgentRow {
  return {
    id: row.id,
    name: row.name,
    cliType: row.cli_type,
    systemPrompt: row.system_prompt,
    mcpConfig: JSON.parse(row.mcp_config) as McpToolVisibility[],
    status: row.status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readRow(): PrimaryAgentRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM primary_agent LIMIT 1`).get() as
    | Row
    | undefined;
  return row ? rowToJson(row) : null;
}

export function upsertConfig(config: PrimaryAgentConfig): PrimaryAgentRow {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = readRow();
  const nextName = config.name ?? existing?.name ?? 'Primary';
  const nextCli = config.cliType ?? existing?.cliType ?? 'claude';
  const nextPrompt = config.systemPrompt ?? existing?.systemPrompt ?? '';
  const nextMcp = config.mcpConfig ?? existing?.mcpConfig ?? [];

  if (!existing) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO primary_agent
         (id, name, cli_type, system_prompt, mcp_config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'STOPPED', ?, ?)`,
    ).run(id, nextName, nextCli, nextPrompt, JSON.stringify(nextMcp), now, now);
  } else {
    db.prepare(
      `UPDATE primary_agent
         SET name = ?, cli_type = ?, system_prompt = ?, mcp_config = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextName, nextCli, nextPrompt, JSON.stringify(nextMcp), now, existing.id);
  }
  return readRow()!;
}

export function setStatus(id: string, status: 'STOPPED' | 'RUNNING'): void {
  const db = getDb();
  db.prepare(
    `UPDATE primary_agent SET status = ?, updated_at = ? WHERE id = ?`,
  ).run(status, new Date().toISOString(), id);
}
