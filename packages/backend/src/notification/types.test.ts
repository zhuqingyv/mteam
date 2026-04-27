// W1-G 测试：纯类型 + 类型守卫 + 通知白名单。
// 不依赖 db/bus；只做字面量与守卫行为断言，以及与 bus/types.ts 白名单对齐尺寸断言。
import { describe, expect, it } from 'bun:test';

import {
  NOTIFIABLE_EVENT_TYPES,
  isCustomRule,
  isCustomRuleTarget,
  isNotifiableEventType,
  isNotificationConfig,
  isProxyMode,
  matchRule,
  type CustomRule,
  type NotificationConfig,
  type ProxyMode,
} from './types.js';

describe('notification/types · ProxyMode 字面量', () => {
  it('三种合法值', () => {
    const modes: ProxyMode[] = ['proxy_all', 'direct', 'custom'];
    for (const m of modes) expect(isProxyMode(m)).toBe(true);
  });

  it('非法值被拒', () => {
    for (const v of ['full_proxy', 'no_proxy', '', null, 42, undefined]) {
      expect(isProxyMode(v as unknown)).toBe(false);
    }
  });
});

describe('notification/types · NOTIFIABLE_EVENT_TYPES 白名单', () => {
  // 与 TASK-LIST W1-G 锁定的 9 项对齐；增减必须同步更新 bus/subscribers/notification.subscriber。
  it('尺寸固定 9', () => {
    expect(NOTIFIABLE_EVENT_TYPES.size).toBe(9);
  });

  it('9 项全部为 bus 已定义事件', () => {
    // 这些类型字面量全部源自 bus/types.ts BusEventType，任一改名/删除都会让本测试 FAIL。
    const expected = [
      'instance.created',
      'instance.deleted',
      'instance.offline_requested',
      'team.created',
      'team.disbanded',
      'team.member_joined',
      'team.member_left',
      'container.crashed',
      'driver.error',
    ];
    for (const t of expected) expect(NOTIFIABLE_EVENT_TYPES.has(t)).toBe(true);
  });

  it('非白名单事件 → false', () => {
    for (const t of ['driver.text', 'comm.message_sent', 'cli.available']) {
      expect(isNotifiableEventType(t)).toBe(false);
    }
  });
});

describe('notification/types · CustomRuleTarget 守卫', () => {
  it('四种 kind 合法', () => {
    expect(isCustomRuleTarget({ kind: 'user', userId: 'u1' })).toBe(true);
    expect(isCustomRuleTarget({ kind: 'agent', instanceId: 'inst_1' })).toBe(true);
    expect(isCustomRuleTarget({ kind: 'primary_agent' })).toBe(true);
    expect(isCustomRuleTarget({ kind: 'drop' })).toBe(true);
  });

  it('user/agent 缺字段或类型错误 → 拒', () => {
    expect(isCustomRuleTarget({ kind: 'user' })).toBe(false);
    expect(isCustomRuleTarget({ kind: 'user', userId: 42 })).toBe(false);
    expect(isCustomRuleTarget({ kind: 'agent' })).toBe(false);
    expect(isCustomRuleTarget({ kind: 'agent', instanceId: null })).toBe(false);
  });

  it('非对象 / 未知 kind → 拒', () => {
    expect(isCustomRuleTarget(null)).toBe(false);
    expect(isCustomRuleTarget('user')).toBe(false);
    expect(isCustomRuleTarget({ kind: 'team' })).toBe(false);
    expect(isCustomRuleTarget({})).toBe(false);
  });
});

describe('notification/types · CustomRule 守卫', () => {
  it('合法规则通过', () => {
    const rule: CustomRule = { matchType: 'team.*', to: { kind: 'user', userId: 'u1' } };
    expect(isCustomRule(rule)).toBe(true);
  });

  it('matchType 非字符串或 to 非法 → 拒', () => {
    expect(isCustomRule({ matchType: 1, to: { kind: 'drop' } })).toBe(false);
    expect(isCustomRule({ matchType: 'x', to: { kind: 'bad' } })).toBe(false);
    expect(isCustomRule({ to: { kind: 'drop' } })).toBe(false);
    expect(isCustomRule(null)).toBe(false);
  });
});

describe('notification/types · matchRule 通配', () => {
  it('完全相等命中', () => {
    const rule: CustomRule = { matchType: 'team.created', to: { kind: 'drop' } };
    expect(matchRule(rule, 'team.created')).toBe(true);
    expect(matchRule(rule, 'team.disbanded')).toBe(false);
  });

  it('尾部 .* 通配命中同前缀族', () => {
    const rule: CustomRule = { matchType: 'team.*', to: { kind: 'drop' } };
    expect(matchRule(rule, 'team.created')).toBe(true);
    expect(matchRule(rule, 'team.disbanded')).toBe(true);
    expect(matchRule(rule, 'team.member_joined')).toBe(true);
    expect(matchRule(rule, 'container.crashed')).toBe(false);
  });

  it('前缀 / 中缀通配不支持（按字面处理，不会误命中）', () => {
    const rule: CustomRule = { matchType: '*.created', to: { kind: 'drop' } };
    // matchType 不以 '.*' 结尾 → 走完全相等；因此 'team.created' 不命中。
    expect(matchRule(rule, 'team.created')).toBe(false);
    expect(matchRule(rule, '*.created')).toBe(true);
  });
});

describe('notification/types · NotificationConfig 守卫', () => {
  const base: NotificationConfig = {
    id: 'default',
    userId: null,
    mode: 'proxy_all',
    updatedAt: '2026-04-25T00:00:00.000Z',
  };

  it('proxy_all / direct 不要求 rules', () => {
    expect(isNotificationConfig({ ...base, mode: 'proxy_all' })).toBe(true);
    expect(isNotificationConfig({ ...base, mode: 'direct' })).toBe(true);
  });

  it('custom 带合法 rules 数组', () => {
    const cfg: NotificationConfig = {
      ...base,
      mode: 'custom',
      rules: [{ matchType: 'team.*', to: { kind: 'user', userId: 'u1' } }],
    };
    expect(isNotificationConfig(cfg)).toBe(true);
  });

  it('rules 非数组或含非法项 → 拒', () => {
    expect(isNotificationConfig({ ...base, mode: 'custom', rules: 'not-array' })).toBe(false);
    expect(isNotificationConfig({ ...base, mode: 'custom', rules: [{ matchType: 1 }] })).toBe(false);
  });

  it('userId string 或 null 均合法', () => {
    expect(isNotificationConfig({ ...base, userId: 'u1' })).toBe(true);
    expect(isNotificationConfig({ ...base, userId: null })).toBe(true);
  });

  it('必填字段缺失 / 类型错误 → 拒', () => {
    expect(isNotificationConfig({ ...base, id: 1 })).toBe(false);
    expect(isNotificationConfig({ ...base, mode: 'unknown' })).toBe(false);
    expect(isNotificationConfig({ ...base, updatedAt: 123 })).toBe(false);
    expect(isNotificationConfig({ ...base, userId: 42 })).toBe(false);
    expect(isNotificationConfig(null)).toBe(false);
  });
});
