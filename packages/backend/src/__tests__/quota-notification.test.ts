// W2 · 配额超限联动通知中心：handleCreateInstance 超限时必须
//   1) 返回 409 + QUOTA_EXCEEDED
//   2) notifications 表落一条 kind='quota_limit'
//   3) bus emit notification.delivered（payload 不带 body，按 id:853 决策）
// 不 mock：走真实 domain + 真实 :memory: SQLite + 真实 bus。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { handleCreateInstance } from '../api/panel/role-instances.js';
import { RoleTemplate } from '../domain/role-template.js';
import { closeDb, getDb } from '../db/connection.js';
import { writeMaxAgents, __resetQuotaCache } from '../system/quota-config.js';
import { listByUser, countUnread } from '../notification-center/repo.js';
import { bus } from '../bus/index.js';
import type { BusEvent, NotificationDeliveredEvent } from '../bus/types.js';

function resetAll(): void {
  closeDb();
  getDb();
  __resetQuotaCache();
}

function seedTemplate(): void {
  RoleTemplate.create({ name: 'tpl', role: 'worker', persona: 'p', availableMcps: [] });
}

describe('配额超限 → 通知中心联动', () => {
  beforeEach(() => {
    resetAll();
    seedTemplate();
    writeMaxAgents(2); // 缩小上限，测试更快
  });
  afterAll(() => {
    closeDb();
    __resetQuotaCache();
  });

  it('超限时 HTTP 返回 409 + notifications 落一条 quota_limit + 发出 notification.delivered', () => {
    const captured: BusEvent[] = [];
    const sub = bus.events$.subscribe((e) => {
      if (e.type === 'notification.delivered') captured.push(e);
    });

    expect(handleCreateInstance({ templateName: 'tpl', memberName: 'a' }).status).toBe(201);
    expect(handleCreateInstance({ templateName: 'tpl', memberName: 'b' }).status).toBe(201);

    const before = countUnread('local');
    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'c' });
    sub.unsubscribe();

    // 1) HTTP 契约
    expect(resp.status).toBe(409);
    const body = resp.body as { code: string; current: number; limit: number };
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.current).toBe(2);
    expect(body.limit).toBe(2);

    // 2) 通知落库
    expect(countUnread('local')).toBe(before + 1);
    const notifs = listByUser('local', { limit: 10 });
    const quota = notifs.find((n) => n.kind === 'quota_limit');
    expect(quota).toBeDefined();
    expect(quota!.severity).toBe('warn');
    expect(quota!.channel).toBe('system');
    expect(quota!.title).toBe('Agent 创建失败');
    expect(quota!.body).toContain('2/2');
    expect(quota!.payload).toEqual({ resource: 'agent', current: 2, limit: 2 });

    // 3) bus 广播 delivered（target=user:local，sourceEventId=通知 id）
    // 可能有其它 subscriber 对 NOTIFIABLE 事件也 emit 了 delivered（真实 bus 单例），
    // 这里只断言必有一条指向本次 quota 通知的。
    const quotaDelivered = captured.filter(
      (e) => (e as NotificationDeliveredEvent).sourceEventType === 'notification.quota_limit',
    );
    expect(quotaDelivered.length).toBe(1);
    const evt = quotaDelivered[0] as NotificationDeliveredEvent;
    expect(evt.target).toEqual({ kind: 'user', id: 'local' });
    expect(evt.sourceEventId).toBe(quota!.id);
  });

  it('未超限不落 quota_limit 通知也不发 quota_limit delivered 事件', () => {
    const captured: BusEvent[] = [];
    const sub = bus.events$.subscribe((e) => {
      if (e.type === 'notification.delivered') captured.push(e);
    });

    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'ok' });
    sub.unsubscribe();

    expect(resp.status).toBe(201);
    const hasQuota = listByUser('local', { limit: 10 }).some((n) => n.kind === 'quota_limit');
    expect(hasQuota).toBe(false);
    const quotaDelivered = captured.filter(
      (e) => (e as NotificationDeliveredEvent).sourceEventType === 'notification.quota_limit',
    );
    expect(quotaDelivered.length).toBe(0);
  });
});
