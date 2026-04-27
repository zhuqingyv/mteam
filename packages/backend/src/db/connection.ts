// DB 连接：从 better-sqlite3 迁移到 bun:sqlite，消除 native 构建依赖。
// - bun:sqlite 的 API 与 better-sqlite3 基本兼容：prepare/run/get/all/transaction 同名同行为。
// - 不同点：bun:sqlite 没有 .pragma(...) 方法，改用 db.exec('PRAGMA ...')。
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { migrateRoleTemplatesAvatar } from './migrations/2026-04-27-role-templates-avatar.js';

const SCHEMA_VERSION = 1;
const SCHEMA_NOTE = 'phase1';

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'team-hub', 'v2.db');
const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

let handle: Database | null = null;

// DAO 级 lazy prepared statements 在 closeDb 时需要被清空，否则 handle 失效后
// 下次使用会拿到悬空的 Statement。模块初始化时 push fn，closeDb 顺序回调。
const closeHooks: Array<() => void> = [];

export function registerCloseHook(fn: () => void): void {
  closeHooks.push(fn);
}

function resolveDbPath(): string {
  return process.env.TEAM_HUB_V2_DB || DEFAULT_DB_PATH;
}

// 把所有 schemas/*.sql 合并执行一次，保证表结构最新。
function applySchemas(db: Database): void {
  const files = readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const combined = files
    .map((f) => readFileSync(resolve(SCHEMAS_DIR, f), 'utf8'))
    .join('\n');
  // 建表时暂关外键，避免 SQL 文件字母排序导致的依赖顺序问题。
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(combined);
  db.exec('PRAGMA foreign_keys = ON');
}

// 已登记当前 SCHEMA_VERSION 则认为表结构已就绪，跳过 applySchemas。
// schema_version 表不存在时 prepare 抛错，走 catch 视作未初始化。
function schemaAlreadyApplied(db: Database): boolean {
  try {
    const row = db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(SCHEMA_VERSION) as { version: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function recordVersion(db: Database): void {
  const existing = db
    .prepare('SELECT version FROM schema_version WHERE version = ?')
    .get(SCHEMA_VERSION) as { version: number } | undefined;
  if (existing) return;
  db.prepare(
    'INSERT INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)'
  ).run(SCHEMA_VERSION, new Date().toISOString(), SCHEMA_NOTE);
}

export function getDb(): Database {
  if (handle) return handle;

  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  // PRAGMA 用 exec 下发；bun:sqlite 无 .pragma() 快捷方法。
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  // 调优：32MB page cache、64MB mmap、WAL 自动 checkpoint、临时表走内存。
  db.exec('PRAGMA cache_size = -32768');
  db.exec('PRAGMA mmap_size = 67108864');
  db.exec('PRAGMA wal_autocheckpoint = 5000');
  db.exec('PRAGMA temp_store = MEMORY');

  if (!schemaAlreadyApplied(db)) {
    applySchemas(db);
    recordVersion(db);
  }
  migrateRoleTemplatesAvatar(db);

  handle = db;
  return handle;
}

export function closeDb(): void {
  // hooks 即使没打开过 DB 也要按注册顺序跑一遍，让 DAO lazy 缓存能被测试清理。
  for (const fn of closeHooks) {
    try { fn(); } catch { /* ignore */ }
  }
  if (!handle) return;
  handle.close();
  handle = null;
}
