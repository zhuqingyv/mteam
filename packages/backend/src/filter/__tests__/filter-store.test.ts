// W1-F filter-store 单测。不 mock：TEAM_HUB_V2_DB=:memory: 起真实 SQLite。
// 覆盖：upsert / list / listForPrincipal (命中/不命中/system) / remove / upsert 覆盖同 id / system ref=NULL。

// 必须在 import connection 之前设置 env。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { VisibilityRule, ActorPrincipal } from '../types.js';
import { createFilterStore } from '../filter-store.js';
import { getDb, closeDb } from '../../db/connection.js';

let store: ReturnType<typeof createFilterStore>;
let db: ReturnType<typeof getDb>;

const baseTs = '2026-04-25T00:00:00.000Z';

function rule(overrides: Partial<VisibilityRule> = {}): VisibilityRule {
  return {
    id: 'r_1',
    principal: { kind: 'user', userId: 'u1' },
    target: { kind: 'agent', instanceId: 'inst_leak' },
    effect: 'deny',
    createdAt: baseTs,
    ...overrides,
  };
}

beforeEach(() => {
  closeDb();
  db = getDb();
  store = createFilterStore();
});

afterAll(() => {
  closeDb();
});

describe('filter-store upsert / list', () => {
  it('upsert 新规则 → list 返回该条', () => {
    store.upsert(rule({ id: 'r_1' }));
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe('r_1');
    expect(all[0]!.principal).toEqual({ kind: 'user', userId: 'u1' });
    expect(all[0]!.target).toEqual({ kind: 'agent', instanceId: 'inst_leak' });
    expect(all[0]!.effect).toBe('deny');
    expect(all[0]!.createdAt).toBe(baseTs);
    expect(all[0]!.note).toBeUndefined();
  });

  it('同 id 再 upsert 覆盖旧行，总数不变', () => {
    store.upsert(rule({ id: 'r_same', effect: 'deny' }));
    store.upsert(rule({ id: 'r_same', effect: 'allow', note: 'updated' }));
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0]!.effect).toBe('allow');
    expect(all[0]!.note).toBe('updated');
  });

  it('note 为 undefined 时落库 NULL、回读仍 undefined（不出现 note:null）', () => {
    store.upsert(rule({ id: 'r_nn' }));
    const row = db
      .prepare('SELECT note FROM visibility_rules WHERE id = ?')
      .get('r_nn') as { note: string | null };
    expect(row.note).toBeNull();
    const back = store.list().find((r) => r.id === 'r_nn')!;
    expect('note' in back).toBe(false);
  });

  it('list 按 created_at ASC, id ASC 稳定排序', () => {
    store.upsert(rule({ id: 'b', createdAt: '2026-04-25T00:00:02.000Z' }));
    store.upsert(rule({ id: 'a', createdAt: '2026-04-25T00:00:01.000Z' }));
    store.upsert(rule({ id: 'c', createdAt: '2026-04-25T00:00:01.000Z' }));
    expect(store.list().map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('filter-store listForPrincipal', () => {
  beforeEach(() => {
    store.upsert(rule({ id: 'r_u1_a', principal: { kind: 'user', userId: 'u1' } }));
    store.upsert(rule({ id: 'r_u1_b', principal: { kind: 'user', userId: 'u1' } }));
    store.upsert(rule({ id: 'r_u2', principal: { kind: 'user', userId: 'u2' } }));
    store.upsert(
      rule({ id: 'r_agent', principal: { kind: 'agent', instanceId: 'inst_A' } }),
    );
    store.upsert(rule({ id: 'r_sys', principal: { kind: 'system' } }));
  });

  it('user 命中：只返回 principal.userId 相同的行', () => {
    const out = store.listForPrincipal({ kind: 'user', userId: 'u1' });
    expect(out.map((r) => r.id).sort()).toEqual(['r_u1_a', 'r_u1_b']);
  });

  it('user 不命中：空数组', () => {
    const out = store.listForPrincipal({ kind: 'user', userId: 'nope' });
    expect(out).toEqual([]);
  });

  it('agent 命中：按 instanceId 匹配', () => {
    const out = store.listForPrincipal({ kind: 'agent', instanceId: 'inst_A' });
    expect(out.map((r) => r.id)).toEqual(['r_agent']);
  });

  it('system principal 命中：走 IS NULL 分支，返回 kind=system 那条', () => {
    const out = store.listForPrincipal({ kind: 'system' });
    expect(out.map((r) => r.id)).toEqual(['r_sys']);
    expect(out[0]!.principal).toEqual({ kind: 'system' });
  });

  it('user 查询不会把 system 规则误带出来（NULL 匹配安全）', () => {
    const out = store.listForPrincipal({ kind: 'user', userId: 'u1' });
    expect(out.every((r) => r.principal.kind === 'user')).toBe(true);
  });
});

describe('filter-store remove', () => {
  it('remove 存在 id 后 list 少一条', () => {
    store.upsert(rule({ id: 'x1' }));
    store.upsert(rule({ id: 'x2' }));
    store.remove('x1');
    expect(store.list().map((r) => r.id)).toEqual(['x2']);
  });

  it('remove 不存在 id 不抛', () => {
    expect(() => store.remove('ghost')).not.toThrow();
    expect(store.list().length).toBe(0);
  });
});

describe('filter-store target 往返', () => {
  const cases: Array<{ name: string; target: VisibilityRule['target'] }> = [
    { name: 'target=user', target: { kind: 'user', userId: 'u9' } },
    { name: 'target=agent', target: { kind: 'agent', instanceId: 'inst_9' } },
    { name: 'target=system', target: { kind: 'system' } },
    { name: 'target=team', target: { kind: 'team', teamId: 't9' } },
  ];

  for (const c of cases) {
    it(`${c.name} 写入后回读结构一致`, () => {
      store.upsert(rule({ id: `r_${c.name}`, target: c.target }));
      const back = store.list().find((r) => r.id === `r_${c.name}`)!;
      expect(back.target).toEqual(c.target);
    });
  }

  it('target=system 时 target_ref 列为 NULL', () => {
    store.upsert(rule({ id: 'r_t_sys', target: { kind: 'system' } }));
    const row = db
      .prepare('SELECT target_ref FROM visibility_rules WHERE id = ?')
      .get('r_t_sys') as { target_ref: string | null };
    expect(row.target_ref).toBeNull();
  });
});

describe('filter-store 非业务检查（REGRESSION R6-3）', () => {
  it('源文件不 import bus / comm / visibility-filter', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const target = path.resolve(path.dirname(here), '..', 'filter-store.ts');
    const src = await fs.readFile(target, 'utf8');
    expect(/from ['"][^'"]*\/bus\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*\/comm\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*visibility-filter/.test(src)).toBe(false);
  });
});

describe('filter-store schema 独立（REGRESSION R2-7）', () => {
  it('visibility_rules 无外键引用 messages / role_instances', () => {
    const fks = db
      .prepare("SELECT * FROM pragma_foreign_key_list('visibility_rules')")
      .all() as Array<{ table: string }>;
    expect(fks.length).toBe(0);
  });

  // 验证 principal_ref / target_ref 允许 NULL 是契约要点（system principal 时）
  it('principal_ref / target_ref 列声明 NULL 允许', () => {
    const cols = db
      .prepare("PRAGMA table_info('visibility_rules')")
      .all() as Array<{ name: string; notnull: number }>;
    const principalRef = cols.find((c) => c.name === 'principal_ref')!;
    const targetRef = cols.find((c) => c.name === 'target_ref')!;
    expect(principalRef.notnull).toBe(0);
    expect(targetRef.notnull).toBe(0);
  });

  // ActorPrincipal 三分支加起来 CHECK 约束生效 —— 误拼会被 SQLite 拒
  it('principal_kind CHECK 约束拒绝未知枚举', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO visibility_rules (id, principal_kind, principal_ref, target_kind, target_ref, effect, note, created_at)
           VALUES ('bad', 'team', 't1', 'user', 'u1', 'allow', NULL, ?)`,
        )
        .run(baseTs),
    ).toThrow();
  });
});

// 让 ESLint 不抱怨未使用导入
const _unused: ActorPrincipal = { kind: 'system' };
void _unused;
