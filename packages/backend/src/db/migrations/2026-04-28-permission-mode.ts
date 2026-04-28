// primary_agent / role_instances 新增 permission_mode TEXT DEFAULT 'auto'。
// 取代 auto_approve boolean 表达"全自动 / 半自动"两种模式；旧 auto_approve 列保留不删。
// 幂等：PRAGMA table_info 探列，已存在跳过；空表（schemas 未加载）也安全跳过。
import type { Database } from 'bun:sqlite';

type ColumnInfo = { name: string };

const DDL: Array<{ table: string; sql: string }> = [
  {
    table: 'primary_agent',
    sql: "ALTER TABLE primary_agent ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto' CHECK(permission_mode IN ('auto','manual'))",
  },
  {
    table: 'role_instances',
    sql: "ALTER TABLE role_instances ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto' CHECK(permission_mode IN ('auto','manual'))",
  },
];

export function migratePermissionMode(db: Database): void {
  for (const { table, sql } of DDL) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
    if (cols.length === 0) continue;
    if (cols.some((c) => c.name === 'permission_mode')) continue;
    db.exec(sql);
  }
}
