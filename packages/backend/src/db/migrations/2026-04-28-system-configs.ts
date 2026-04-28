// Phase 5 · system_configs 表兜底建表。
// 幂等：新库 applySchemas 已建好 → sqlite_master 查到表 → 跳过；
// v2 老库在 SCHEMA_VERSION bump(3→4) 后会重新触发 applySchemas，CREATE TABLE IF NOT EXISTS 自动兜底。
// 本 migration 只管"表不存在且 applySchemas 未覆盖"的极端情形。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'system_configs.sql',
);

export function migrateSystemConfigs(db: Database): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'")
    .get() as { name: string } | undefined;
  if (row) return;
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}
