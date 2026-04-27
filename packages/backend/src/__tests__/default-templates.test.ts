// ensureDefaultTemplates + role-templates-avatar migration 单测。
// 用 :memory: SQLite，每例前 closeDb 重新连，互不污染。
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { getDb, closeDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import {
  ensureDefaultTemplates,
  DEFAULT_TEMPLATE_COUNT,
} from '../domain/default-templates.js';
import { migrateRoleTemplatesAvatar } from '../db/migrations/2026-04-27-role-templates-avatar.js';

describe('role_templates avatar migration', () => {
  beforeEach(() => {
    closeDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('新库 schema 已含 avatar 列', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(role_templates)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'avatar')).toBe(true);
  });

  it('migration 幂等：重复运行不抛错', () => {
    const db = getDb();
    expect(() => migrateRoleTemplatesAvatar(db)).not.toThrow();
    expect(() => migrateRoleTemplatesAvatar(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(role_templates)').all() as Array<{
      name: string;
    }>;
    const avatarCols = cols.filter((c) => c.name === 'avatar');
    expect(avatarCols.length).toBe(1);
  });

  it('migration 对老库无 avatar 列时 ADD COLUMN 补齐', () => {
    const db = getDb();
    // 模拟老库：删掉 avatar 列重建表
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE role_templates_legacy (
        name TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        description TEXT,
        persona TEXT,
        available_mcps TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec('DROP TABLE role_templates');
    db.exec('ALTER TABLE role_templates_legacy RENAME TO role_templates');
    db.exec('PRAGMA foreign_keys = ON');

    const before = db.prepare('PRAGMA table_info(role_templates)').all() as Array<{
      name: string;
    }>;
    expect(before.some((c) => c.name === 'avatar')).toBe(false);

    migrateRoleTemplatesAvatar(db);

    const after = db.prepare('PRAGMA table_info(role_templates)').all() as Array<{
      name: string;
    }>;
    expect(after.some((c) => c.name === 'avatar')).toBe(true);
  });
});

describe('RoleTemplate.avatar 字段', () => {
  beforeEach(() => {
    closeDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('create 写入 avatar 并 findByName 读回', () => {
    RoleTemplate.create({
      name: 'tpl-a',
      role: 'dev',
      avatar: 'avatar-07',
    });
    const got = RoleTemplate.findByName('tpl-a');
    expect(got!.avatar).toBe('avatar-07');
  });

  it('create 不传 avatar 时默认 null', () => {
    const tpl = RoleTemplate.create({ name: 'tpl-b', role: 'dev' });
    expect(tpl.avatar).toBeNull();
    const got = RoleTemplate.findByName('tpl-b');
    expect(got!.avatar).toBeNull();
  });

  it('update 可改 avatar，可显式设为 null', () => {
    RoleTemplate.create({ name: 'tpl-c', role: 'dev', avatar: 'avatar-01' });
    const updated = RoleTemplate.update('tpl-c', { avatar: 'avatar-02' });
    expect(updated.avatar).toBe('avatar-02');
    const cleared = RoleTemplate.update('tpl-c', { avatar: null });
    expect(cleared.avatar).toBeNull();
  });

  it('update 不传 avatar 时保留原值', () => {
    RoleTemplate.create({ name: 'tpl-d', role: 'dev', avatar: 'avatar-05' });
    const updated = RoleTemplate.update('tpl-d', { role: 'lead' });
    expect(updated.avatar).toBe('avatar-05');
  });

  it('toJSON 包含 avatar', () => {
    const tpl = RoleTemplate.create({
      name: 'tpl-e',
      role: 'dev',
      avatar: 'avatar-11',
    });
    expect(tpl.toJSON().avatar).toBe('avatar-11');
  });
});

describe('ensureDefaultTemplates', () => {
  beforeEach(() => {
    closeDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('空表时插入 11 个默认模板', () => {
    const db = getDb();
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM role_templates')
      .get() as { n: number };
    expect(before.n).toBe(0);

    ensureDefaultTemplates();

    const all = RoleTemplate.listAll();
    expect(all.length).toBe(DEFAULT_TEMPLATE_COUNT);
    expect(DEFAULT_TEMPLATE_COUNT).toBe(11);

    // 每个模板都有 avatar / persona / description / availableMcps
    for (const t of all) {
      expect(t.avatar).toMatch(/^avatar-\d{2}$/);
      expect(t.persona).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.availableMcps.length).toBeGreaterThan(0);
    }
    // avatar 唯一且从 01 开始覆盖 11
    const avatars = new Set(all.map((t) => t.avatar));
    expect(avatars.size).toBe(11);
    for (let i = 1; i <= 11; i++) {
      const id = `avatar-${i.toString().padStart(2, '0')}`;
      expect(avatars.has(id)).toBe(true);
    }

    // 三个代表性 name 存在
    expect(RoleTemplate.findByName('frontend-dev')).not.toBeNull();
    expect(RoleTemplate.findByName('backend-dev')).not.toBeNull();
    expect(RoleTemplate.findByName('product-manager')).not.toBeNull();
  });

  it('已有数据时整张跳过，不覆盖用户模板', () => {
    RoleTemplate.create({ name: 'user-custom', role: 'dev' });

    ensureDefaultTemplates();

    const all = RoleTemplate.listAll();
    expect(all.length).toBe(1);
    expect(all[0]!.name).toBe('user-custom');
    expect(RoleTemplate.findByName('frontend-dev')).toBeNull();
  });

  it('二次调用（已插入 11 个）不重复插入', () => {
    ensureDefaultTemplates();
    const firstCount = RoleTemplate.listAll().length;
    ensureDefaultTemplates();
    const secondCount = RoleTemplate.listAll().length;
    expect(secondCount).toBe(firstCount);
  });

  it('默认模板 availableMcps 含 mteam 和 mnemo', () => {
    ensureDefaultTemplates();
    const frontend = RoleTemplate.findByName('frontend-dev')!;
    const names = frontend.availableMcps.map((m) => m.name);
    expect(names).toContain('mteam');
    expect(names).toContain('mnemo');
  });
});
