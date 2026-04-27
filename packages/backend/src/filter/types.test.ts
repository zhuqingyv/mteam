// W1-E types 测试。
// 主体是类型级断言（编译期），少量运行时守卫测试覆盖 isVisibilityRule 分支。

import { describe, it, expect } from 'bun:test';
import {
  isActorPrincipal,
  isRuleTarget,
  isVisibilityRule,
  type ActorPrincipal,
  type RuleTarget,
  type VisibilityRule,
  type VisibilityDecision,
  type FilterStore,
} from './types.js';

// ----------------------------------------------------------------------------
// 类型级断言（编译期；若类型漂移会编译报错）
// ----------------------------------------------------------------------------

// ActorPrincipal discriminated union 三条分支
const _userP: ActorPrincipal = { kind: 'user', userId: 'u1' };
const _agentP: ActorPrincipal = { kind: 'agent', instanceId: 'inst_1' };
const _systemP: ActorPrincipal = { kind: 'system' };

// RuleTarget 是 ActorPrincipal 的超集，额外允许 team
const _teamT: RuleTarget = { kind: 'team', teamId: 't1' };
const _userT: RuleTarget = { kind: 'user', userId: 'u2' };

// team 不能作为 ActorPrincipal（本期核心约束）
// @ts-expect-error team 不是可观测主体，只能作为 target
const _badPrincipal: ActorPrincipal = { kind: 'team', teamId: 't1' };

// VisibilityRule 全字段
const _rule: VisibilityRule = {
  id: 'r1',
  principal: { kind: 'user', userId: 'u1' },
  target: { kind: 'team', teamId: 't1' },
  effect: 'allow',
  note: 'demo',
  createdAt: '2026-04-25T00:00:00Z',
};

// effect 只能是 allow / deny
// @ts-expect-error effect 枚举外值不合法
const _badEffect: VisibilityRule = { ..._rule, effect: 'maybe' };

// VisibilityDecision 两条分支
const _allowDec: VisibilityDecision = { decision: 'allow', byRuleId: 'default_allow' };
const _denyDec: VisibilityDecision = { decision: 'deny', byRuleId: 'r1' };

// @ts-expect-error deny 分支的 byRuleId 必须是 string，不允许 'default_allow' 字面量以外的 undefined
const _badDec: VisibilityDecision = { decision: 'deny' };

// FilterStore 方法签名冻结
const _storeShape: Pick<FilterStore, 'list' | 'listForPrincipal' | 'upsert' | 'remove'> = {
  list: () => [],
  listForPrincipal: (_p: ActorPrincipal) => [],
  upsert: (_r: VisibilityRule) => {},
  remove: (_id: string) => {},
};

// 防止 TS6133 "declared but never read"
void [
  _userP, _agentP, _systemP, _teamT, _userT, _badPrincipal,
  _rule, _badEffect, _allowDec, _denyDec, _badDec, _storeShape,
];

// ----------------------------------------------------------------------------
// 运行时守卫
// ----------------------------------------------------------------------------

describe('isActorPrincipal', () => {
  it('user / agent / system 合法', () => {
    expect(isActorPrincipal({ kind: 'user', userId: 'u1' })).toBe(true);
    expect(isActorPrincipal({ kind: 'agent', instanceId: 'i1' })).toBe(true);
    expect(isActorPrincipal({ kind: 'system' })).toBe(true);
  });

  it('team 作为 principal 非法', () => {
    expect(isActorPrincipal({ kind: 'team', teamId: 't1' })).toBe(false);
  });

  it('kind 缺失 / 空 id 非法', () => {
    expect(isActorPrincipal({ kind: 'user', userId: '' })).toBe(false);
    expect(isActorPrincipal({ kind: 'agent' })).toBe(false);
    expect(isActorPrincipal({})).toBe(false);
  });

  it('null / 基本类型返回 false', () => {
    expect(isActorPrincipal(null)).toBe(false);
    expect(isActorPrincipal(undefined)).toBe(false);
    expect(isActorPrincipal('user')).toBe(false);
    expect(isActorPrincipal([])).toBe(false);
  });
});

describe('isRuleTarget', () => {
  it('team 合法', () => {
    expect(isRuleTarget({ kind: 'team', teamId: 't1' })).toBe(true);
  });

  it('ActorPrincipal 全类型合法', () => {
    expect(isRuleTarget({ kind: 'user', userId: 'u1' })).toBe(true);
    expect(isRuleTarget({ kind: 'system' })).toBe(true);
  });

  it('team 空 id 非法', () => {
    expect(isRuleTarget({ kind: 'team', teamId: '' })).toBe(false);
  });

  it('未知 kind 非法', () => {
    expect(isRuleTarget({ kind: 'everyone' })).toBe(false);
  });
});

describe('isVisibilityRule', () => {
  const valid = (): VisibilityRule => ({
    id: 'r1',
    principal: { kind: 'user', userId: 'u1' },
    target: { kind: 'team', teamId: 't1' },
    effect: 'allow',
    createdAt: '2026-04-25T00:00:00Z',
  });

  it('完整规则合法', () => {
    expect(isVisibilityRule(valid())).toBe(true);
    expect(isVisibilityRule({ ...valid(), note: 'hi' })).toBe(true);
  });

  it('effect 非枚举非法', () => {
    expect(isVisibilityRule({ ...valid(), effect: 'maybe' })).toBe(false);
  });

  it('principal 非法则规则非法', () => {
    expect(isVisibilityRule({ ...valid(), principal: { kind: 'team', teamId: 't1' } })).toBe(false);
  });

  it('缺 id / createdAt 非法', () => {
    const r = valid();
    expect(isVisibilityRule({ ...r, id: '' })).toBe(false);
    expect(isVisibilityRule({ ...r, createdAt: '' })).toBe(false);
  });

  it('note 非 string 非法', () => {
    expect(isVisibilityRule({ ...valid(), note: 42 })).toBe(false);
  });
});
