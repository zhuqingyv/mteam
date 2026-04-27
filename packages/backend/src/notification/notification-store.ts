// W1-H · notification_configs DAO。
// 契约：docs/phase-ws/TASK-LIST.md §W1-H；schema 在 db/schemas/notification_configs.sql。
// 只依赖 getDb() 与 ./types（类型）；不 import bus / comm / ws。
//
// 默认配置语义：store.get() 未命中 → 即时返回 {mode:'direct'} 并落库 ensure，
//   不要求调用方自行插入。理由：notification.subscriber 每事件都会查，少一次
//   "未配置 → 无结果 → fallback" 的旁路分支，让订阅层判定只看 mode。

import type { Database } from 'bun:sqlite';
import { getDb } from '../db/connection.js';
import {
  isCustomRule,
  isProxyMode,
  type CustomRule,
  type NotificationConfig,
  type NotificationStore,
  type ProxyMode,
} from './types.js';

interface Row {
  id: string;
  user_id: string | null;
  mode: string;
  rules_json: string | null;
  updated_at: string;
}

const DEFAULT_ID = 'default';

// 坏 JSON / 单条非法都走回退（W1-H 完成判据 §2：rules_json 解析失败回退 default）。
// 失败指 JSON.parse 抛错 或 结果非数组 或 任一元素不是合法 CustomRule。
function parseRules(json: string | null): CustomRule[] | undefined {
  if (json == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every(isCustomRule)) return undefined;
  return parsed as CustomRule[];
}

// 坏 mode 走 direct（同口径回退），避免历史脏数据拖累订阅层。
function normalizeMode(raw: string): ProxyMode {
  return isProxyMode(raw) ? raw : 'direct';
}

function rowToConfig(row: Row): NotificationConfig {
  const mode = normalizeMode(row.mode);
  const rules = mode === 'custom' ? parseRules(row.rules_json) : undefined;
  return {
    id: row.id,
    userId: row.user_id,
    mode: rules === undefined && mode === 'custom' ? 'direct' : mode,
    ...(rules ? { rules } : {}),
    updatedAt: row.updated_at,
  };
}

function defaultConfigFor(userId: string | null): NotificationConfig {
  return {
    id: userId ?? DEFAULT_ID,
    userId,
    mode: 'direct',
    updatedAt: new Date().toISOString(),
  };
}

export function createNotificationStore(db: Database = getDb()): NotificationStore {
  const selectByUser = db.prepare<Row, [string | null]>(
    'SELECT id, user_id, mode, rules_json, updated_at FROM notification_configs WHERE user_id IS ?',
  );
  const upsertStmt = db.prepare<
    void,
    [string, string | null, ProxyMode, string | null, string]
  >(
    `INSERT INTO notification_configs (id, user_id, mode, rules_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id    = excluded.user_id,
       mode       = excluded.mode,
       rules_json = excluded.rules_json,
       updated_at = excluded.updated_at`,
  );

  function writeConfig(cfg: NotificationConfig): void {
    const rulesJson = cfg.mode === 'custom' && cfg.rules ? JSON.stringify(cfg.rules) : null;
    upsertStmt.run(cfg.id, cfg.userId, cfg.mode, rulesJson, cfg.updatedAt);
  }

  return {
    get(userId) {
      const row = selectByUser.get(userId) as Row | undefined;
      if (!row) {
        const cfg = defaultConfigFor(userId);
        writeConfig(cfg);
        return cfg;
      }
      return rowToConfig(row);
    },

    upsert(cfg) {
      writeConfig(cfg);
    },
  };
}
