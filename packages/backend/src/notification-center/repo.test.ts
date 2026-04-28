// notification-center/repo 单测 — :memory: 真跑 bun:sqlite，不 mock。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb } from '../db/connection.js';
import {
  pushNotification, findById, listByUser, countUnread, acknowledge, acknowledgeAll,
} from './repo.js';
import type { NotificationChannel, NotificationKind, Severity } from './types.js';

type PushInput = Parameters<typeof pushNotification>[0];

function mk(o: Partial<PushInput> = {}): PushInput {
  return {
    userId: 'u1', kind: 'system', channel: 'system', severity: 'info',
    title: 't', body: 'b', payload: {}, ...o,
  };
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('pushNotification + findById', () => {
  it('push 返回完整 record；findById 取回同样内容；source 字段透传', () => {
    const rec = pushNotification(mk({
      kind: 'quota_limit', severity: 'warn', title: '配额超限', body: '50/50',
      payload: { resource: 'agent', current: 50, limit: 50 },
      sourceEventType: 'quota.exceeded', sourceEventId: 'evt-1',
    }));
    expect(rec.id).toBeTruthy();
    expect(rec.kind).toBe('quota_limit');
    expect(rec.payload).toEqual({ resource: 'agent', current: 50, limit: 50 });
    expect(rec.acknowledgedAt).toBeNull();
    expect(rec.sourceEventType).toBe('quota.exceeded');
    expect(findById(rec.id)).toEqual(rec);
    expect(findById('nope')).toBeNull();
  });

  it('不同 kind/channel/severity 组合均能落库并读回', () => {
    const combos: Array<[NotificationKind, NotificationChannel, Severity]> = [
      ['action_item_reminder', 'system', 'info'], ['action_item_timeout', 'both', 'warn'],
      ['agent_error', 'system', 'error'], ['team_lifecycle', 'in_app', 'info'],
      ['instance_lifecycle', 'in_app', 'info'], ['approval', 'both', 'info'],
    ];
    for (const [kind, channel, severity] of combos) {
      const f = findById(pushNotification(mk({ kind, channel, severity })).id)!;
      expect([f.kind, f.channel, f.severity]).toEqual([kind, channel, severity]);
    }
  });

  it('userId=null 落 default 行；payload 省略 → 空对象', () => {
    const rec = pushNotification(mk({ userId: null, payload: undefined as unknown as Record<string, unknown> }));
    expect(rec.userId).toBeNull();
    expect(rec.payload).toEqual({});
    expect(listByUser(null).map((r) => r.id)).toContain(rec.id);
  });
});

describe('listByUser', () => {
  it('默认返回所有（含已读），按 created_at DESC', async () => {
    const a = pushNotification(mk({ title: 'a' })); await Bun.sleep(10);
    const b = pushNotification(mk({ title: 'b' })); await Bun.sleep(10);
    const c = pushNotification(mk({ title: 'c' }));
    acknowledge(b.id);
    expect(listByUser('u1').map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it('unreadOnly=true 只返回未读', () => {
    const a = pushNotification(mk()); const b = pushNotification(mk());
    acknowledge(a.id);
    expect(listByUser('u1', { unreadOnly: true }).map((r) => r.id)).toEqual([b.id]);
  });

  it('按 userId 隔离 + limit 生效', () => {
    pushNotification(mk({ userId: 'u1' })); pushNotification(mk({ userId: 'u2' }));
    expect(listByUser('u1').every((r) => r.userId === 'u1')).toBe(true);
    expect(listByUser('u2').every((r) => r.userId === 'u2')).toBe(true);
    for (let i = 0; i < 5; i++) pushNotification(mk({ userId: 'lim' }));
    expect(listByUser('lim', { limit: 3 })).toHaveLength(3);
  });
});

describe('countUnread', () => {
  it('随 push / acknowledge 变化且按 userId 隔离', () => {
    expect(countUnread('u1')).toBe(0);
    const a = pushNotification(mk({ userId: 'u1' }));
    pushNotification(mk({ userId: 'u1' }));
    pushNotification(mk({ userId: 'u2' }));
    expect(countUnread('u1')).toBe(2);
    expect(countUnread('u2')).toBe(1);
    expect(countUnread('nobody')).toBe(0);
    acknowledge(a.id);
    expect(countUnread('u1')).toBe(1);
  });
});

describe('acknowledge / acknowledgeAll', () => {
  it('单条 ack 写 acknowledged_at；幂等不覆盖；不存在返回 null', async () => {
    const rec = pushNotification(mk());
    const first = acknowledge(rec.id)!;
    expect(first.acknowledgedAt).toBeTruthy();
    await Bun.sleep(20);
    const second = acknowledge(rec.id)!;
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
    expect(acknowledge('missing')).toBeNull();
  });

  it('批量已读返回更新条数；不影响其他用户', () => {
    pushNotification(mk({ userId: 'u1' }));
    pushNotification(mk({ userId: 'u1' }));
    const c = pushNotification(mk({ userId: 'u1' }));
    pushNotification(mk({ userId: 'u2' }));
    acknowledge(c.id);
    expect(acknowledgeAll('u1')).toBe(2);
    expect(countUnread('u1')).toBe(0);
    expect(acknowledgeAll('u1')).toBe(0); // 再调 0
    expect(countUnread('u2')).toBe(1);
  });
});
