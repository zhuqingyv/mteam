// Phase WS · W1-F：visibility_rules 表 DAO（SQLite 实现）。
// 非业务模块：只依赖 W1-E 的 types + getDb()；不 import bus / comm / visibility-filter。
// schema 见 db/schemas/visibility_rules.sql（由 db/connection.ts 启动时 applySchemas 载入）。

import type {
  ActorPrincipal,
  FilterStore,
  RuleTarget,
  VisibilityRule,
} from './types.js';
import { getDb } from '../db/connection.js';

interface Row {
  id: string;
  principal_kind: 'user' | 'agent' | 'system';
  principal_ref: string | null;
  target_kind: 'user' | 'agent' | 'system' | 'team';
  target_ref: string | null;
  effect: 'allow' | 'deny';
  note: string | null;
  created_at: string;
}

// principal: kind='system' 时 ref=NULL；其他 kind 写对应 id。
function principalToRow(p: ActorPrincipal): { kind: Row['principal_kind']; ref: string | null } {
  switch (p.kind) {
    case 'user':
      return { kind: 'user', ref: p.userId };
    case 'agent':
      return { kind: 'agent', ref: p.instanceId };
    case 'system':
      return { kind: 'system', ref: null };
  }
}

function targetToRow(t: RuleTarget): { kind: Row['target_kind']; ref: string | null } {
  switch (t.kind) {
    case 'user':
      return { kind: 'user', ref: t.userId };
    case 'agent':
      return { kind: 'agent', ref: t.instanceId };
    case 'system':
      return { kind: 'system', ref: null };
    case 'team':
      return { kind: 'team', ref: t.teamId };
  }
}

function rowToPrincipal(kind: Row['principal_kind'], ref: string | null): ActorPrincipal {
  switch (kind) {
    case 'user':
      return { kind: 'user', userId: ref ?? '' };
    case 'agent':
      return { kind: 'agent', instanceId: ref ?? '' };
    case 'system':
      return { kind: 'system' };
  }
}

function rowToTarget(kind: Row['target_kind'], ref: string | null): RuleTarget {
  switch (kind) {
    case 'team':
      return { kind: 'team', teamId: ref ?? '' };
    case 'user':
      return { kind: 'user', userId: ref ?? '' };
    case 'agent':
      return { kind: 'agent', instanceId: ref ?? '' };
    case 'system':
      return { kind: 'system' };
  }
}

function rowToRule(r: Row): VisibilityRule {
  const rule: VisibilityRule = {
    id: r.id,
    principal: rowToPrincipal(r.principal_kind, r.principal_ref),
    target: rowToTarget(r.target_kind, r.target_ref),
    effect: r.effect,
    createdAt: r.created_at,
  };
  if (r.note !== null) rule.note = r.note;
  return rule;
}

export function createFilterStore(): FilterStore {
  const db = getDb();

  const selAll = db.prepare('SELECT * FROM visibility_rules ORDER BY created_at ASC, id ASC');
  // system principal 落库 ref=NULL；SQLite 里 ref=? 匹配不到 NULL，所以 system 单独一支
  const selByPrincipalRef = db.prepare(
    `SELECT * FROM visibility_rules
       WHERE principal_kind = ? AND principal_ref = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const selSystemPrincipal = db.prepare(
    `SELECT * FROM visibility_rules
       WHERE principal_kind = 'system' AND principal_ref IS NULL
       ORDER BY created_at ASC, id ASC`,
  );

  // upsert = INSERT OR REPLACE；id 是 PK，按 id 覆盖。
  // 不用 ON CONFLICT ... DO UPDATE 是为了把"整条规则替换"语义写得最直白。
  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO visibility_rules
       (id, principal_kind, principal_ref, target_kind, target_ref, effect, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const delStmt = db.prepare('DELETE FROM visibility_rules WHERE id = ?');

  return {
    list(): VisibilityRule[] {
      return (selAll.all() as Row[]).map(rowToRule);
    },

    listForPrincipal(p: ActorPrincipal): VisibilityRule[] {
      const { kind, ref } = principalToRow(p);
      const rows =
        ref === null
          ? (selSystemPrincipal.all() as Row[])
          : (selByPrincipalRef.all(kind, ref) as Row[]);
      return rows.map(rowToRule);
    },

    upsert(rule: VisibilityRule): void {
      const p = principalToRow(rule.principal);
      const t = targetToRow(rule.target);
      upsertStmt.run(
        rule.id,
        p.kind,
        p.ref,
        t.kind,
        t.ref,
        rule.effect,
        rule.note ?? null,
        rule.createdAt,
      );
    },

    remove(id: string): void {
      delStmt.run(id);
    },
  };
}
