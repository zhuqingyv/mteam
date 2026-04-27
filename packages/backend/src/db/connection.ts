// DB 连接：从 better-sqlite3 迁移到 bun:sqlite，消除 native 构建依赖。
// - bun:sqlite 的 API 与 better-sqlite3 基本兼容：prepare/run/get/all/transaction 同名同行为。
// - 不同点：bun:sqlite 没有 .pragma(...) 方法，改用 db.exec('PRAGMA ...')。
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { migrateMessagesEnvelope } from './migrations/2026-04-25-messages-envelope.js';
import { migrateMessagesDropInstanceFk } from './migrations/2026-04-26-messages-drop-instance-fk.js';
import { migrateSandboxAutoApprove } from './migrations/2026-04-27-sandbox-autoapprove.js';
import { migrateRoleTemplatesAvatar } from './migrations/2026-04-27-role-templates-avatar.js';

const SCHEMA_VERSION = 1;
const SCHEMA_NOTE = 'phase1';

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'team-hub', 'v2.db');
const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

let handle: Database | null = null;

// closeDb 时触发的清理钩子：DAO 把 lazy-prepared statement 的重置函数注册进来，
// 这样下次 getDb() 拿到新 handle 后第一次使用会重新 prepare。
const resetHooks: Array<() => void> = [];

export function registerCloseHook(fn: () => void): void {
  resetHooks.push(fn);
}

function resolveDbPath(): string {
  return process.env.TEAM_HUB_V2_DB || DEFAULT_DB_PATH;
}

// 查 schema_version；表不存在或行不存在都返回 false。
// :memory: 每次 new Database 都是全新的，这里查到的一定是 false → 走全量 apply。
function schemaAlreadyApplied(db: Database): boolean {
  try {
    const row = db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(SCHEMA_VERSION) as { version: number } | undefined;
    return !!row;
  } catch {
    return false;  // 表还没建起来
  }
}

// 把所有 schemas/*.sql 合并执行一次，保证表结构最新。
// 已登记 SCHEMA_VERSION 的库直接跳过——省掉 15 次 readFileSync + 一次大 exec。
function applySchemas(db: Database): void {
  if (schemaAlreadyApplied(db)) return;
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
  // 性能调优：用户 Mac 内存有限，mmap 只给 64MB 不到处刷页。
  // 老版 SQLite 可能不支持某条 PRAGMA，单条 try/catch 避免整体启动失败。
  applyTuningPragmas(db);

  applySchemas(db);
  migrateMessagesEnvelope(db);
  migrateMessagesDropInstanceFk(db);
  migrateSandboxAutoApprove(db);
  migrateRoleTemplatesAvatar(db);
  recordVersion(db);

  handle = db;
  return handle;
}

export function closeDb(): void {
  if (!handle) return;
  handle.close();
  handle = null;
  for (const fn of resetHooks) fn();
}

// 逐条下发调优 PRAGMA；单条失败（老 SQLite 不支持）不打断启动。
function applyTuningPragmas(db: Database): void {
  const pragmas = [
    'PRAGMA cache_size = -32768',       // 32MB page cache（负数=KB）
    'PRAGMA mmap_size = 67108864',      // 64MB
    'PRAGMA wal_autocheckpoint = 5000', // 5000 帧再 checkpoint
    'PRAGMA temp_store = MEMORY',
  ];
  for (const sql of pragmas) {
    try {
      db.exec(sql);
    } catch {
      // 老版 SQLite 不支持该 PRAGMA；忽略避免破坏启动。
    }
  }
}
