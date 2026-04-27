// role_templates 表补 avatar 列。老库 CREATE TABLE IF NOT EXISTS 不会补新列,
// 靠 ALTER TABLE ADD COLUMN 兜底。幂等:PRAGMA table_info 探列,已有则跳过。
import type { Database } from 'bun:sqlite';

type ColumnInfo = { name: string; notnull: number; dflt_value: unknown; type: string };

export function migrateRoleTemplatesAvatar(db: Database): void {
  const cols = db.prepare('PRAGMA table_info(role_templates)').all() as ColumnInfo[];
  if (cols.length === 0) return; // 表不存在(schemas 未加载完) —— 跳过
  if (cols.some((c) => c.name === 'avatar')) return;
  db.exec('ALTER TABLE role_templates ADD COLUMN avatar TEXT');
}
