// DB 连接：从 better-sqlite3 迁移到 bun:sqlite，消除 native 构建依赖。
// - bun:sqlite 的 API 与 better-sqlite3 基本兼容：prepare/run/get/all/transaction 同名同行为。
// - 不同点：bun:sqlite 没有 .pragma(...) 方法，改用 db.exec('PRAGMA ...')。
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCHEMA_VERSION = 1;
const SCHEMA_NOTE = 'phase1';

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'team-hub', 'v2.db');
const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

let handle: Database | null = null;

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

// 将当前 SCHEMA_VERSION 登记到 schema_version 表（若未登记）。
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

  applySchemas(db);
  recordVersion(db);

  handle = db;
  return handle;
}

export function closeDb(): void {
  if (!handle) return;
  handle.close();
  handle = null;
}
