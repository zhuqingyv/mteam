// W2-J messages v1 -> v2 envelope 迁移单测
// 不 mock：真实 bun:sqlite :memory: DB
// 覆盖 REGRESSION §2.9 U-150 ~ U-156
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateMessagesEnvelope } from '../db/migrations/2026-04-25-messages-envelope.js';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schemas');

// W1-C 前的 v1 messages 表（无 v2 列）—— 精简版，剥掉 FK 指向别表的依赖
const V1_MESSAGES_DDL = `
CREATE TABLE messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_instance_id TEXT,
  to_instance_id   TEXT NOT NULL,
  team_id          TEXT,
  kind             TEXT NOT NULL DEFAULT 'chat'
                   CHECK(kind IN ('chat','task','broadcast','system')),
  summary          TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  read_at          TEXT,
  reply_to_id      INTEGER
);
`;

function listColumns(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function applyCurrentMessagesSchema(db: Database): void {
  // 模拟 applySchemas 中 messages.sql 的执行。
  // messages 表有指向 teams / role_instances 的 FK，这里只测 messages 迁移，
  // 跳过 FK 依赖表，所以全程保持 foreign_keys=OFF（prepared 校验走 OFF 就不查 FK 目标表）。
  const sql = readFileSync(join(SCHEMAS_DIR, 'messages.sql'), 'utf8');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(sql);
}

describe('W2-J messages envelope migration', () => {
  // U-150: 新库 CREATE TABLE 直接带全部 v2 列
  it('U-150 新库应包含全部 v2 列', () => {
    const db = new Database(':memory:');
    applyCurrentMessagesSchema(db);
    migrateMessagesEnvelope(db);
    const cols = listColumns(db, 'messages');
    for (const c of [
      'from_kind',
      'from_user_id',
      'from_display',
      'to_kind',
      'to_display',
      'envelope_uuid',
      'attachments_json',
    ]) {
      expect(cols).toContain(c);
    }
    db.close();
  });

  // U-151: 老库 ALTER TABLE 补列
  it('U-151 老 v1 库迁移后含新列 + 保留老行', () => {
    const db = new Database(':memory:');
    db.exec(V1_MESSAGES_DDL);
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, team_id, kind, summary, content, sent_at) VALUES (?, ?, ?, 'chat', 'hello', 'hi', '2026-04-01T00:00:00Z')"
    ).run('alice', 'bob', 't1');
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, team_id, kind, summary, content, sent_at) VALUES (NULL, 'bob', NULL, 'system', 'sys', 'sys-body', '2026-04-02T00:00:00Z')"
    ).run();

    migrateMessagesEnvelope(db);

    const cols = listColumns(db, 'messages');
    for (const c of ['from_kind', 'envelope_uuid', 'attachments_json']) {
      expect(cols).toContain(c);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  // U-152: envelope_uuid backfill
  it('U-152 envelope_uuid backfill 为 msg_<id>，无空值', () => {
    const db = new Database(':memory:');
    db.exec(V1_MESSAGES_DDL);
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at) VALUES ('a', 'b', 'chat', 'c', '2026-04-01T00:00:00Z')"
    ).run();

    migrateMessagesEnvelope(db);

    const empties = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE envelope_uuid IS NULL OR envelope_uuid = ''"
      )
      .get() as { n: number };
    expect(empties.n).toBe(0);
    const row = db
      .prepare('SELECT id, envelope_uuid FROM messages LIMIT 1')
      .get() as { id: number; envelope_uuid: string };
    expect(row.envelope_uuid).toBe(`msg_${row.id}`);
    db.close();
  });

  // U-153: 系统消息 from_kind backfill
  it('U-153 老 system 行回填 from_kind=system', () => {
    const db = new Database(':memory:');
    db.exec(V1_MESSAGES_DDL);
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at) VALUES (NULL, 'bob', 'system', 'sys-body', '2026-04-02T00:00:00Z')"
    ).run();
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at) VALUES ('alice', 'bob', 'chat', 'hi', '2026-04-02T01:00:00Z')"
    ).run();

    migrateMessagesEnvelope(db);

    const sys = db
      .prepare("SELECT from_kind FROM messages WHERE from_instance_id IS NULL")
      .get() as { from_kind: string };
    expect(sys.from_kind).toBe('system');
    const normal = db
      .prepare("SELECT from_kind FROM messages WHERE from_instance_id = 'alice'")
      .get() as { from_kind: string };
    expect(normal.from_kind).toBe('agent');
    db.close();
  });

  // U-154: UNIQUE 索引生效
  it('U-154 重复 envelope_uuid 抛违约', () => {
    const db = new Database(':memory:');
    applyCurrentMessagesSchema(db);
    migrateMessagesEnvelope(db);

    const insert = db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at, envelope_uuid) VALUES ('a', 'b', 'chat', 'x', '2026-04-01T00:00:00Z', ?)"
    );
    insert.run('dup-uuid-1');
    expect(() => insert.run('dup-uuid-1')).toThrow();
    db.close();
  });

  // U-155: 幂等
  it('U-155 连续运行两次不抛、不覆盖既有值', () => {
    const db = new Database(':memory:');
    db.exec(V1_MESSAGES_DDL);
    db.prepare(
      "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at) VALUES ('a', 'b', 'chat', 'x', '2026-04-01T00:00:00Z')"
    ).run();

    migrateMessagesEnvelope(db);
    const firstUuid = (
      db.prepare('SELECT envelope_uuid FROM messages LIMIT 1').get() as {
        envelope_uuid: string;
      }
    ).envelope_uuid;

    // 手动改一个非默认值，模拟后续业务写入
    db.exec("UPDATE messages SET envelope_uuid = 'custom-uuid', from_display = 'Alice'");

    expect(() => migrateMessagesEnvelope(db)).not.toThrow();
    const after = db
      .prepare('SELECT envelope_uuid, from_display FROM messages LIMIT 1')
      .get() as { envelope_uuid: string; from_display: string };
    // 第二次迁移不应覆盖已有值
    expect(after.envelope_uuid).toBe('custom-uuid');
    expect(after.from_display).toBe('Alice');
    expect(firstUuid).toMatch(/^msg_\d+$/);
    db.close();
  });

  // U-156: CHECK 约束
  it('U-156 from_kind=other 抛 CHECK 违约', () => {
    const db = new Database(':memory:');
    applyCurrentMessagesSchema(db);
    migrateMessagesEnvelope(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (from_instance_id, to_instance_id, kind, content, sent_at, envelope_uuid, from_kind) VALUES ('a', 'b', 'chat', 'x', '2026-04-01T00:00:00Z', 'u1', 'other')"
        )
        .run()
    ).toThrow();
    db.close();
  });

  // 额外：UNIQUE 索引从普通升级为 UNIQUE
  it('从普通 idx_msg_env_uuid 升级为 UNIQUE', () => {
    const db = new Database(':memory:');
    applyCurrentMessagesSchema(db);
    // 原始 schema 建的是普通索引
    const before = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='idx_msg_env_uuid'")
      .get() as { sql: string };
    expect(before.sql).not.toMatch(/\bUNIQUE\b/i);

    migrateMessagesEnvelope(db);
    const after = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='idx_msg_env_uuid'")
      .get() as { sql: string };
    expect(after.sql).toMatch(/\bUNIQUE\b/i);
    db.close();
  });
});
