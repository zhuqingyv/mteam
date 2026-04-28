// system.defaultPermissionMode 配置 DAO。读写 system_configs(key, value_json)。
// 实例级覆盖优先：instance.permissionMode > 此全局默认 > 兜底 'auto'。
import type { Database } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type { PermissionMode } from '../agent-driver/types.js';

const KEY = 'system.defaultPermissionMode';
const DEFAULT: PermissionMode = 'auto';

let cached: PermissionMode | null = null;

registerCloseHook(() => { cached = null; });

function select(db: Database): { value_json: string } | undefined {
  return db.prepare('SELECT value_json FROM system_configs WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
}

function upsert(db: Database, value: PermissionMode): void {
  db.prepare(
    `INSERT INTO system_configs (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(value), new Date().toISOString());
}

function parseValue(json: string): PermissionMode | null {
  try {
    const v = JSON.parse(json);
    return v === 'manual' ? 'manual' : v === 'auto' ? 'auto' : null;
  } catch {
    return null;
  }
}

export function readDefaultPermissionMode(): PermissionMode {
  if (cached !== null) return cached;
  const row = select(getDb());
  cached = row ? parseValue(row.value_json) ?? DEFAULT : DEFAULT;
  return cached;
}

export function writeDefaultPermissionMode(value: PermissionMode): void {
  if (value !== 'auto' && value !== 'manual') {
    throw new Error(`system.defaultPermissionMode must be "auto" or "manual", got ${String(value)}`);
  }
  upsert(getDb(), value);
  cached = value;
}

export function __resetPermissionCache(): void { cached = null; }
