// system.maxAgents 配置 DAO。读写 system_configs(key, value_json)。
// 缓存一份在模块内存，避免 RoleInstance.create 每次都查 DB；writeMaxAgents 覆盖缓存。
// closeDb 后 DAO 重建；测试通过 __resetCache 显式清理。

import type { Database } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';

const KEY = 'system.maxAgents';
// 默认 50：50 个 role_instance 已能覆盖单机常规团队规模，同时避免失控创建打爆句柄。
const DEFAULT_MAX_AGENTS = 50;

let cached: number | null = null;

registerCloseHook(() => {
  cached = null;
});

interface Row {
  value_json: string;
}

function select(db: Database): Row | undefined {
  return db
    .prepare('SELECT value_json FROM system_configs WHERE key = ?')
    .get(KEY) as Row | undefined;
}

function upsert(db: Database, value: number): void {
  db.prepare(
    `INSERT INTO system_configs (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(value), new Date().toISOString());
}

function parseValue(json: string): number | null {
  try {
    const v = JSON.parse(json);
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
    return null;
  } catch {
    return null;
  }
}

export function readMaxAgents(): number {
  if (cached !== null) return cached;
  const db = getDb();
  const row = select(db);
  if (!row) {
    cached = DEFAULT_MAX_AGENTS;
    return cached;
  }
  const v = parseValue(row.value_json);
  cached = v ?? DEFAULT_MAX_AGENTS;
  return cached;
}

export function writeMaxAgents(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`system.maxAgents must be non-negative integer, got ${value}`);
  }
  upsert(getDb(), value);
  cached = value;
}

// 测试用：显式清缓存，让下次 read 重新查 DB。
export function __resetQuotaCache(): void {
  cached = null;
}

export const QUOTA_DEFAULT_MAX_AGENTS = DEFAULT_MAX_AGENTS;
