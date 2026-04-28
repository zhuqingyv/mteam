// Phase 5 · workflow_templates 表兜底建表。幂等：
// 新库 applySchemas 已建好 → 探到表存在则跳过；
// 老库因 SCHEMA_VERSION bump 而跳过 applySchemas 的场景（未来），由此 migration 兜底建表。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'workflow_templates.sql',
);

export function migrateWorkflowTemplates(db: Database): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_templates'")
    .get() as { name: string } | undefined;
  if (row) return;
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}
