// Phase 5 · notifications 表兜底建表。
// 新库：applySchemas 读 schemas/notifications.sql 已建好 → PRAGMA 探到 → 跳过。
// 老库（SCHEMA_VERSION bump）：applySchemas 会重新 CREATE TABLE IF NOT EXISTS → 此 migration 兜底。
// 设计：docs/phase5/notification-system-design.md §2.4
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'notifications.sql',
);

export function migrateNotifications(db: Database): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
    .get() as { name: string } | undefined;
  if (row) return;
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}
