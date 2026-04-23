// RoleTemplate CRUD 单测。使用 :memory: SQLite 保证互不污染。
// 注意：connection.ts 内有模块级单例 handle，每个测试前调 closeDb 重新连。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// 关键：在 import domain 之前先设环境变量，保证 connection 使用 :memory:。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { RoleTemplate } from '../domain/role-template.js';
import { closeDb } from '../db/connection.js';

describe('RoleTemplate', () => {
  // 每个用例前把 DB 关掉，这样下一个 getDb() 会重新建 :memory: DB，避免数据残留。
  beforeEach(() => {
    closeDb();
  });

  afterAll(() => {
    closeDb();
  });

  describe('create', () => {
    it('创建并返回模板对象', () => {
      const tpl = RoleTemplate.create({
        name: 'planner',
        role: 'lead',
        description: '规划师',
        persona: 'you are planner',
        availableMcps: ['fs', 'web'],
      });
      expect(tpl.name).toBe('planner');
      expect(tpl.role).toBe('lead');
      expect(tpl.description).toBe('规划师');
      expect(tpl.persona).toBe('you are planner');
      expect(tpl.availableMcps).toEqual(['fs', 'web']);
      expect(tpl.createdAt).toBeTruthy();
      expect(tpl.updatedAt).toBeTruthy();
    });

    it('默认字段：description/persona null，availableMcps 空数组', () => {
      const tpl = RoleTemplate.create({ name: 'empty', role: 'worker' });
      expect(tpl.description).toBeNull();
      expect(tpl.persona).toBeNull();
      expect(tpl.availableMcps).toEqual([]);
    });

    it('重复 name 创建应抛错（主键冲突）', () => {
      RoleTemplate.create({ name: 'dup', role: 'worker' });
      // better-sqlite3 会抛 SqliteError；我们只断言抛错，不强绑具体类型
      expect(() => RoleTemplate.create({ name: 'dup', role: 'worker' })).toThrow();
    });
  });

  describe('findByName', () => {
    it('存在返回实例', () => {
      RoleTemplate.create({ name: 'coder', role: 'dev' });
      const got = RoleTemplate.findByName('coder');
      expect(got).not.toBeNull();
      expect(got!.name).toBe('coder');
      expect(got!.role).toBe('dev');
    });

    it('不存在返回 null', () => {
      expect(RoleTemplate.findByName('ghost')).toBeNull();
    });

    it('反序列化 availableMcps 正确', () => {
      RoleTemplate.create({ name: 'mcp-user', role: 'dev', availableMcps: ['a', 'b', 'c'] });
      const got = RoleTemplate.findByName('mcp-user');
      expect(got!.availableMcps).toEqual(['a', 'b', 'c']);
    });
  });

  describe('listAll', () => {
    it('空库返回空数组', () => {
      expect(RoleTemplate.listAll()).toEqual([]);
    });

    it('按创建顺序 ASC 返回', () => {
      RoleTemplate.create({ name: 't1', role: 'r' });
      // 让 created_at 秒数不同，避免同一毫秒下顺序抖动
      const t2 = new Date(Date.now() + 10).toISOString();
      RoleTemplate.create({ name: 't2', role: 'r' });
      const list = RoleTemplate.listAll();
      expect(list.length).toBe(2);
      // 至少验证两者都存在
      const names = list.map((t) => t.name);
      expect(names).toContain('t1');
      expect(names).toContain('t2');
      // 因为 SQL 用 created_at ASC，t1 先创建应排第一
      expect(list[0]!.name).toBe('t1');
      void t2;
    });
  });

  describe('update', () => {
    it('只更新给定字段，其他保留', () => {
      RoleTemplate.create({
        name: 'u1',
        role: 'dev',
        description: 'old desc',
        persona: 'old persona',
        availableMcps: ['a'],
      });
      const updated = RoleTemplate.update('u1', { role: 'lead' });
      expect(updated.role).toBe('lead');
      expect(updated.description).toBe('old desc');
      expect(updated.persona).toBe('old persona');
      expect(updated.availableMcps).toEqual(['a']);
    });

    it('description 可显式设为 null', () => {
      RoleTemplate.create({ name: 'u2', role: 'dev', description: 'orig' });
      const updated = RoleTemplate.update('u2', { description: null });
      expect(updated.description).toBeNull();
    });

    it('不存在的 name 抛错', () => {
      expect(() => RoleTemplate.update('ghost', { role: 'x' })).toThrow(/not found/);
    });

    it('update 后 updatedAt 变化', async () => {
      const created = RoleTemplate.create({ name: 'u3', role: 'dev' });
      // 等 2ms 确保 ISO 字符串不同
      await new Promise((r) => setTimeout(r, 2));
      const updated = RoleTemplate.update('u3', { role: 'lead' });
      expect(updated.updatedAt).not.toBe(created.updatedAt);
    });
  });

  describe('delete', () => {
    it('删除后 findByName 返回 null', () => {
      RoleTemplate.create({ name: 'd1', role: 'dev' });
      RoleTemplate.delete('d1');
      expect(RoleTemplate.findByName('d1')).toBeNull();
    });

    it('删除不存在的 name 不抛错（幂等）', () => {
      // 纯 SQL DELETE，无匹配行时不报错
      expect(() => RoleTemplate.delete('ghost')).not.toThrow();
    });
  });

  describe('toJSON', () => {
    it('返回纯数据对象', () => {
      const tpl = RoleTemplate.create({ name: 'j1', role: 'dev', availableMcps: ['x'] });
      const json = tpl.toJSON();
      expect(json.availableMcps).toEqual(['x']);
      // 确保是拷贝不是引用
      json.availableMcps.push('y');
      expect(tpl.availableMcps).toEqual(['x']);
    });
  });
});
