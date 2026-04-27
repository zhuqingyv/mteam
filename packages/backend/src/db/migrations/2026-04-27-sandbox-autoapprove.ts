// primary_agent / role_instances 补齐 sandbox + auto_approve 字段。
// 已上线老库 CREATE TABLE IF NOT EXISTS 不会改列，靠 ALTER TABLE ADD COLUMN 兜底。
// 幂等：PRAGMA table_info 探列，已有则跳过；空表（新库首次启动走 applySchemas）也安全跳过。
import type { Database } from 'bun:sqlite';

type ColumnInfo = { name: string; notnull: number; dflt_value: unknown; type: string };

interface TableSpec {
  table: string;
  columns: Array<{ name: string; ddl: string }>;
}

// 默认值与 schemas/*.sql 保持一致：
//   primary_agent: sandbox=1 / auto_approve=1（秘书身份，全自动）
//   role_instances: sandbox=0 / auto_approve=0（成员保守）
const TABLES: TableSpec[] = [
  {
    table: 'primary_agent',
    columns: [
      {
        name: 'sandbox',
        ddl: 'ALTER TABLE primary_agent ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 1 CHECK(sandbox IN (0,1))',
      },
      {
        name: 'auto_approve',
        ddl: 'ALTER TABLE primary_agent ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1 CHECK(auto_approve IN (0,1))',
      },
    ],
  },
  {
    table: 'role_instances',
    columns: [
      {
        name: 'sandbox',
        ddl: 'ALTER TABLE role_instances ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0 CHECK(sandbox IN (0,1))',
      },
      {
        name: 'auto_approve',
        ddl: 'ALTER TABLE role_instances ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0 CHECK(auto_approve IN (0,1))',
      },
    ],
  },
];

export function migrateSandboxAutoApprove(db: Database): void {
  for (const spec of TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${spec.table})`).all() as ColumnInfo[];
    if (cols.length === 0) continue; // 表不存在（schemas 未加载完）—— 跳过，不破
    const has = (n: string): boolean => cols.some((c) => c.name === n);
    for (const c of spec.columns) {
      if (has(c.name)) continue;
      db.exec(c.ddl);
    }
  }
}
