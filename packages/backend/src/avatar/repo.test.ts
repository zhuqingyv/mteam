// avatar/repo 单测 — 不 mock，用 :memory: 真跑 SQLite。
// schemas/avatars.sql 会被 connection.ts applySchemas 一并建表。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb } from '../db/connection.js';
import {
  listVisible,
  listAll,
  addCustom,
  remove,
  restoreBuiltins,
  randomOne,
  findById,
} from './repo.js';
import { ensureBuiltinAvatars } from './init.js';

beforeEach(() => {
  closeDb();
  getDb();
});

afterAll(() => {
  closeDb();
});

describe('avatar/repo listVisible', () => {
  it('隐藏的内置头像不出现在 listVisible 里', () => {
    ensureBuiltinAvatars();
    expect(listVisible()).toHaveLength(20);

    remove('avatar-03');
    const visible = listVisible();
    expect(visible.find((a) => a.id === 'avatar-03')).toBeUndefined();
    expect(visible).toHaveLength(19);

    // listAll 仍能看到 hidden 的那条
    const all = listAll();
    const hidden3 = all.find((a) => a.id === 'avatar-03');
    expect(hidden3).toBeDefined();
    expect(hidden3!.hidden).toBe(true);
  });
});

describe('avatar/repo addCustom', () => {
  it('新增自定义头像：builtin=false，能被 findById / listVisible 查到', () => {
    const row = addCustom('avatar-custom-xyz', 'xyz.png');
    expect(row.id).toBe('avatar-custom-xyz');
    expect(row.filename).toBe('xyz.png');
    expect(row.builtin).toBe(false);
    expect(row.hidden).toBe(false);
    expect(typeof row.createdAt).toBe('string');

    expect(findById('avatar-custom-xyz')).toEqual(row);
    expect(listVisible().some((a) => a.id === 'avatar-custom-xyz')).toBe(true);
  });
});

describe('avatar/repo remove', () => {
  it('删除内置：hidden=true，记录仍在库里', () => {
    ensureBuiltinAvatars();
    remove('avatar-01');

    const row = findById('avatar-01');
    expect(row).not.toBeNull();
    expect(row!.builtin).toBe(true);
    expect(row!.hidden).toBe(true);
  });

  it('删除自定义：真删，findById 返回 null', () => {
    addCustom('avatar-custom-del', 'del.png');
    expect(findById('avatar-custom-del')).not.toBeNull();

    remove('avatar-custom-del');
    expect(findById('avatar-custom-del')).toBeNull();
  });

  it('删除不存在的 id：静默无报错', () => {
    expect(() => remove('avatar-not-exists')).not.toThrow();
  });
});

describe('avatar/repo restoreBuiltins', () => {
  it('隐藏多个内置后 restore：全部 hidden=0，返回恢复数量', () => {
    ensureBuiltinAvatars();
    remove('avatar-05');
    remove('avatar-06');
    remove('avatar-07');

    // 自定义也加一个，确认不受影响
    addCustom('avatar-custom-rb', 'rb.png');

    const restored = restoreBuiltins();
    expect(restored).toBe(3);

    expect(findById('avatar-05')!.hidden).toBe(false);
    expect(findById('avatar-06')!.hidden).toBe(false);
    expect(findById('avatar-07')!.hidden).toBe(false);

    // 自定义头像不受影响
    expect(findById('avatar-custom-rb')!.hidden).toBe(false);
  });

  it('没有隐藏条目时 restore 返回 0', () => {
    ensureBuiltinAvatars();
    expect(restoreBuiltins()).toBe(0);
  });
});

describe('avatar/repo randomOne', () => {
  it('从 visible 里返回一个；全部隐藏时返回 null', () => {
    ensureBuiltinAvatars();
    const pick = randomOne();
    expect(pick).not.toBeNull();
    expect(pick!.hidden).toBe(false);

    // 把 20 个内置全删（全部 hidden=1），空库下返回 null
    for (let i = 1; i <= 20; i++) {
      const n = String(i).padStart(2, '0');
      remove(`avatar-${n}`);
    }
    expect(listVisible()).toHaveLength(0);
    expect(randomOne()).toBeNull();
  });
});

describe('avatar/init ensureBuiltinAvatars', () => {
  it('幂等：重复调用不报错且不产生重复行', () => {
    ensureBuiltinAvatars();
    ensureBuiltinAvatars();
    ensureBuiltinAvatars();

    const all = listAll();
    expect(all).toHaveLength(20);
    // 首条和末条的 id / filename 符合命名
    const first = all.find((a) => a.id === 'avatar-01');
    const last = all.find((a) => a.id === 'avatar-20');
    expect(first).toBeDefined();
    expect(first!.filename).toBe('avatar-01.png');
    expect(first!.builtin).toBe(true);
    expect(last).toBeDefined();
    expect(last!.filename).toBe('avatar-20.png');
  });

  it('已隐藏的内置不会被 ensure 覆盖回 hidden=0', () => {
    ensureBuiltinAvatars();
    remove('avatar-10');
    expect(findById('avatar-10')!.hidden).toBe(true);

    ensureBuiltinAvatars(); // 再次启动
    // INSERT OR IGNORE：已存在的行不动，hidden 仍为 true
    expect(findById('avatar-10')!.hidden).toBe(true);
  });
});
