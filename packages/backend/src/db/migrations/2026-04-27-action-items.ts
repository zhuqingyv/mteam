// Phase 4 · action_items 表兜底建表。
// 幂等：新库 applySchemas 已建好 → PRAGMA 探到表存在 → 跳过；
// v2 老库 applySchemas 因 SCHEMA_VERSION bump(2→3) 被重新触发 CREATE TABLE IF NOT EXISTS → 此 migration 兜底跳过。
// 详见 docs/phase4/INTERFACE-CONTRACTS.md C-8。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'action_items.sql',
);

export function migrateActionItems(db: Database): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_items'")
    .get() as { name: string } | undefined;
  if (row) return;
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}
