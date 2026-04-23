import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCHEMA_VERSION = 1;
const SCHEMA_NOTE = 'phase1';

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'team-hub', 'v2.db');
const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

let handle: Database.Database | null = null;

function resolveDbPath(): string {
  return process.env.TEAM_HUB_V2_DB || DEFAULT_DB_PATH;
}

function applySchemas(db: Database.Database): void {
  const files = readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const combined = files
    .map((f) => readFileSync(resolve(SCHEMAS_DIR, f), 'utf8'))
    .join('\n');
  db.exec(combined);
}

function recordVersion(db: Database.Database): void {
  const existing = db
    .prepare('SELECT version FROM schema_version WHERE version = ?')
    .get(SCHEMA_VERSION) as { version: number } | undefined;
  if (existing) return;
  db.prepare(
    'INSERT INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)'
  ).run(SCHEMA_VERSION, new Date().toISOString(), SCHEMA_NOTE);
}

export function getDb(): Database.Database {
  if (handle) return handle;

  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

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
