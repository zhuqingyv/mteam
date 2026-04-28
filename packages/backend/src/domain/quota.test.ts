// RoleInstance 配额检查单测。:memory: SQLite，每 describe 重建库互不污染。
// 不 mock：走真实 domain / DAO。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { closeDb } from '../db/connection.js';
import { RoleTemplate } from './role-template.js';
import { RoleInstance, QuotaExceededError } from './role-instance.js';
import { writeMaxAgents, __resetQuotaCache } from '../system/quota-config.js';

function seedTemplate(): void {
  RoleTemplate.create({ name: 'tpl-quota', role: 'dev' });
}

function createOne(i: number): RoleInstance {
  return RoleInstance.create({
    templateName: 'tpl-quota',
    memberName: `m-${i}`,
  });
}

describe('RoleInstance 配额检查', () => {
  beforeEach(() => {
    closeDb();
    __resetQuotaCache();
    seedTemplate();
  });

  afterAll(() => {
    closeDb();
    __resetQuotaCache();
  });

  it('达到默认 50 上限时第 51 个抛 QUOTA_EXCEEDED', () => {
    for (let i = 0; i < 50; i++) createOne(i);
    try {
      createOne(50);
      expect.unreachable('第 51 个应抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const e = err as QuotaExceededError;
      expect(e.code).toBe('QUOTA_EXCEEDED');
      expect(e.current).toBe(50);
      expect(e.limit).toBe(50);
    }
    expect(RoleInstance.listAll().length).toBe(50);
  });

  it('删除一个之后可以再创建', () => {
    for (let i = 0; i < 50; i++) createOne(i);
    const victim = RoleInstance.listAll()[0]!;
    victim.delete();
    expect(RoleInstance.listAll().length).toBe(49);

    const fresh = createOne(99);
    expect(fresh.id).toBeTruthy();
    expect(RoleInstance.listAll().length).toBe(50);
  });

  it('system.maxAgents=5 时第 6 个抛 QUOTA_EXCEEDED', () => {
    writeMaxAgents(5);
    for (let i = 0; i < 5; i++) createOne(i);
    try {
      createOne(5);
      expect.unreachable('第 6 个应抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const e = err as QuotaExceededError;
      expect(e.current).toBe(5);
      expect(e.limit).toBe(5);
    }
  });
});
