// notification-store 单测 — 覆盖 W1-H 完成判据 §2 + REGRESSION R3-7（DAO 回写）。
// 不 mock：TEAM_HUB_V2_DB=:memory: 起真实 SQLite；connection.ts 的 applySchemas
// 会把 notification_configs.sql 一并建表。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { createNotificationStore } from './notification-store.js';
import type { CustomRule, NotificationConfig, NotificationStore } from './types.js';
import { getDb, closeDb } from '../db/connection.js';

let store: NotificationStore;
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  closeDb();
  db = getDb();
  store = createNotificationStore(db);
});

afterAll(() => {
  closeDb();
});

describe('notification-store default ensure', () => {
  it('get(null) 无配置 → 返回 direct 默认并落库', () => {
    const cfg = store.get(null);
    expect(cfg.mode).toBe('direct');
    expect(cfg.userId).toBeNull();
    expect(cfg.id).toBe('default');
    expect(cfg.rules).toBeUndefined();
    expect(typeof cfg.updatedAt).toBe('string');

    const count = (db
      .prepare('SELECT COUNT(*) AS c FROM notification_configs')
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('get(userId) 无配置 → 返回 direct 默认，id=userId', () => {
    const cfg = store.get('u1');
    expect(cfg.mode).toBe('direct');
    expect(cfg.userId).toBe('u1');
    expect(cfg.id).toBe('u1');
  });

  it('get 同 key 幂等：第二次不重复插行', () => {
    store.get(null);
    store.get(null);
    const count = (db
      .prepare('SELECT COUNT(*) AS c FROM notification_configs')
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('notification-store upsert / 回写往返', () => {
  const rules: CustomRule[] = [
    { matchType: 'team.*', to: { kind: 'user', userId: 'u1' } },
    { matchType: 'container.crashed', to: { kind: 'primary_agent' } },
    { matchType: 'driver.error', to: { kind: 'drop' } },
  ];

  it('upsert custom 规则后 get 回来完整相等', () => {
    const cfg: NotificationConfig = {
      id: 'default',
      userId: null,
      mode: 'custom',
      rules,
      updatedAt: '2026-04-25T10:00:00.000Z',
    };
    store.upsert(cfg);
    const got = store.get(null);
    expect(got).toEqual(cfg);
  });

  it('upsert 覆盖已存在的配置（proxy_all → custom）', () => {
    store.upsert({
      id: 'default', userId: null, mode: 'proxy_all', updatedAt: '2026-04-25T10:00:00.000Z',
    });
    store.upsert({
      id: 'default', userId: null, mode: 'custom', rules,
      updatedAt: '2026-04-25T11:00:00.000Z',
    });
    const got = store.get(null);
    expect(got.mode).toBe('custom');
    expect(got.rules).toEqual(rules);
    expect(got.updatedAt).toBe('2026-04-25T11:00:00.000Z');

    const count = (db
      .prepare('SELECT COUNT(*) AS c FROM notification_configs')
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('非 custom 模式下 rules 字段不落 rules_json', () => {
    store.upsert({
      id: 'default', userId: null, mode: 'proxy_all',
      rules,  // 刻意传，但 mode!=custom 应丢弃
      updatedAt: '2026-04-25T10:00:00.000Z',
    });
    const row = db
      .prepare('SELECT rules_json FROM notification_configs WHERE id = ?')
      .get('default') as { rules_json: string | null };
    expect(row.rules_json).toBeNull();

    const got = store.get(null);
    expect(got.mode).toBe('proxy_all');
    expect(got.rules).toBeUndefined();
  });

  it('重启后读回（模拟 R3-7 persistence）', () => {
    store.upsert({
      id: 'default', userId: null, mode: 'custom', rules,
      updatedAt: '2026-04-25T10:00:00.000Z',
    });
    // 模拟"进程重启"：关 db 句柄，重新 getDb() + 新 store
    // 注意 :memory: 会丢数据；这里用文件 db 才能真实断言持久化
    closeDb();
    const tmp = `/tmp/notif-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.TEAM_HUB_V2_DB = tmp;
    try {
      const db2 = getDb();
      const store2 = createNotificationStore(db2);
      store2.upsert({
        id: 'default', userId: null, mode: 'custom', rules,
        updatedAt: '2026-04-25T10:00:00.000Z',
      });
      closeDb();

      const db3 = getDb();
      const store3 = createNotificationStore(db3);
      const got = store3.get(null);
      expect(got.mode).toBe('custom');
      expect(got.rules).toEqual(rules);
    } finally {
      process.env.TEAM_HUB_V2_DB = ':memory:';
      closeDb();
    }
  });
});

describe('notification-store rules_json 回退', () => {
  it('坏 JSON → 回退 default（mode=direct，rules 丢弃）', () => {
    // 绕过 DAO 直接写脏数据模拟历史损坏
    db.prepare(
      `INSERT INTO notification_configs (id, user_id, mode, rules_json, updated_at)
       VALUES ('default', NULL, 'custom', '{not-json', '2026-04-25T10:00:00.000Z')`,
    ).run();
    const got = store.get(null);
    expect(got.mode).toBe('direct');
    expect(got.rules).toBeUndefined();
  });

  it('rules_json 非数组 → 回退', () => {
    db.prepare(
      `INSERT INTO notification_configs (id, user_id, mode, rules_json, updated_at)
       VALUES ('default', NULL, 'custom', '{"a":1}', '2026-04-25T10:00:00.000Z')`,
    ).run();
    const got = store.get(null);
    expect(got.mode).toBe('direct');
    expect(got.rules).toBeUndefined();
  });

  it('数组里含非法规则 → 回退（整体视为脏数据）', () => {
    db.prepare(
      `INSERT INTO notification_configs (id, user_id, mode, rules_json, updated_at)
       VALUES ('default', NULL, 'custom', ?, '2026-04-25T10:00:00.000Z')`,
    ).run(JSON.stringify([{ matchType: 'team.*' /* 缺 to */ }]));
    const got = store.get(null);
    expect(got.mode).toBe('direct');
    expect(got.rules).toBeUndefined();
  });

  it('schema CHECK 约束拦非法 mode（双保险，DAO 回退不再被触发）', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO notification_configs (id, user_id, mode, rules_json, updated_at)
         VALUES ('wat', 'wat-user', 'wat', NULL, '2026-04-25T10:00:00.000Z')`,
      ).run();
    }).toThrow();
  });
});

describe('notification-store 多用户隔离', () => {
  it('不同 userId 各自一条，互不覆盖', () => {
    const base = '2026-04-25T10:00:00.000Z';
    store.upsert({ id: 'u1', userId: 'u1', mode: 'proxy_all', updatedAt: base });
    store.upsert({ id: 'u2', userId: 'u2', mode: 'custom',
      rules: [{ matchType: 'team.*', to: { kind: 'user', userId: 'u2' } }],
      updatedAt: base });

    expect(store.get('u1').mode).toBe('proxy_all');
    expect(store.get('u2').mode).toBe('custom');
    expect(store.get('u2').rules?.[0]?.to).toEqual({ kind: 'user', userId: 'u2' });
  });
});

describe('notification-store 非业务 import 守门', () => {
  it('源文件不 import bus/comm/ws', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const src = await fs.readFile(
      path.resolve(path.dirname(here), 'notification-store.ts'),
      'utf8',
    );
    expect(/from ['"][^'"]*\/bus\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*\/comm\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*\/ws\//.test(src)).toBe(false);
  });
});
