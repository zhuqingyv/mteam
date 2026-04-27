// db/connection PRAGMA 调优验证。:memory: 真跑，不 mock。
// journal_mode/WAL 在 :memory: 上无效，这里只验证调优 PRAGMA。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb, registerCloseHook } from './connection.js';

beforeEach(() => {
  closeDb();
  getDb();
});

afterAll(() => {
  closeDb();
});

function pragmaGet(name: string): number {
  const db = getDb();
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  if (!row) throw new Error(`PRAGMA ${name} returned no row`);
  const values = Object.values(row);
  return Number(values[0]);
}

describe('db/connection 调优 PRAGMA', () => {
  it('cache_size = -32768（32MB page cache）', () => {
    expect(pragmaGet('cache_size')).toBe(-32768);
  });

  it('mmap_size PRAGMA 执行不报错（:memory: 下 pragma 读取返回空行，属预期）', () => {
    const db = getDb();
    // 在 :memory: 上 PRAGMA mmap_size 查询返回空集，但 set 不应抛
    expect(() => db.exec('PRAGMA mmap_size = 67108864')).not.toThrow();
  });

  it('wal_autocheckpoint = 5000', () => {
    expect(pragmaGet('wal_autocheckpoint')).toBe(5000);
  });

  it('temp_store = MEMORY（返回 2）', () => {
    // 0=DEFAULT, 1=FILE, 2=MEMORY
    expect(pragmaGet('temp_store')).toBe(2);
  });

  it('原有 PRAGMA 不被破坏：foreign_keys / busy_timeout / synchronous', () => {
    expect(pragmaGet('foreign_keys')).toBe(1);
    expect(pragmaGet('busy_timeout')).toBe(5000);
    expect(pragmaGet('synchronous')).toBe(1); // NORMAL
  });
});

describe('registerCloseHook', () => {
  it('closeDb 时顺序触发已注册钩子', () => {
    const calls: string[] = [];
    registerCloseHook(() => calls.push('a'));
    registerCloseHook(() => calls.push('b'));
    closeDb();
    expect(calls).toEqual(['a', 'b']);
    // 还原 beforeEach 状态
    getDb();
  });
});

describe('P1-4 schema_version 跳过 applySchemas', () => {
  it(':memory: 首次启动：schema_version 正好一行 version=当前 SCHEMA_VERSION', () => {
    // beforeEach 已 closeDb+getDb，拿到全新 :memory:
    const db = getDb();
    const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(3);
  });

  it('文件 DB：第二次 getDb 跳过 applySchemas（手动删表不会被重建）', () => {
    const origEnv = process.env.TEAM_HUB_V2_DB;
    const tmpPath = `/tmp/mteam-schema-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    try {
      closeDb();
      process.env.TEAM_HUB_V2_DB = tmpPath;

      // 首次 getDb：走全量 apply
      const db1 = getDb();
      const v1 = db1.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
      expect(v1).toHaveLength(1);
      expect(v1[0].version).toBe(3);
      // teams 表这时应在（schemas/teams.sql 已被 apply）
      const teamsBefore = db1
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='teams'`)
        .get();
      expect(teamsBefore).toBeTruthy();

      // 手动把 teams 删了，模拟"如果 applySchemas 再跑就会把它重建"
      db1.exec('DROP TABLE teams');
      closeDb();

      // 第二次 getDb：schema_version 已登记 → 应当跳过 applySchemas →
      // teams 表应保持缺失。
      const db2 = getDb();
      const teamsAfter = db2
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='teams'`)
        .get();
      expect(teamsAfter).toBeFalsy();
      const v2 = db2.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
      expect(v2).toHaveLength(1);
      expect(v2[0].version).toBe(3);

      closeDb();
    } finally {
      // 清理文件 + 恢复环境
      try { require('node:fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      try { require('node:fs').unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
      try { require('node:fs').unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
      if (origEnv === undefined) delete process.env.TEAM_HUB_V2_DB;
      else process.env.TEAM_HUB_V2_DB = origEnv;
      // 让后续 beforeEach 拿到干净的 :memory:
      closeDb();
    }
  });

  it(':memory: 每次 new DB 都是全新——applySchemas 必须跑（schema_version 从无到有）', () => {
    // :memory: 下 close+open 是全新库，schema_version 表不在 → schemaAlreadyApplied 走 catch
    // 触发 apply。这里直接验证：新库里 schema_version 有行、核心表存在。
    closeDb();
    const db = getDb();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='role_templates'`)
      .get();
    expect(row).toBeTruthy();
    const ver = db.prepare('SELECT version FROM schema_version WHERE version = ?').get(3);
    expect(ver).toBeTruthy();
  });
});
