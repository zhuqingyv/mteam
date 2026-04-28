// W2：pushNotification 写库成功后要 emit bus notification.delivered，
// payload 带 title/body/channel/kind/notificationId，WS 端据此触发 OS 通知。
// :memory: DB，用全局 bus（repo 无法注入），测完在 afterAll 里清 DB。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { Subscription } from 'rxjs';
import { getDb, closeDb } from '../db/connection.js';
import { bus } from '../bus/events.js';
import { pushNotification } from './repo.js';
import type { NotificationDeliveredEvent } from '../bus/types.js';

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

function captureNext(): { promise: Promise<NotificationDeliveredEvent>; sub: Subscription } {
  let resolve!: (v: NotificationDeliveredEvent) => void;
  const promise = new Promise<NotificationDeliveredEvent>((r) => { resolve = r; });
  const sub = bus.on('notification.delivered').subscribe((e) => resolve(e));
  return { promise, sub };
}

describe('pushNotification emit notification.delivered', () => {
  it('push 后收到事件，payload 含 title/body/channel/kind/notificationId', async () => {
    const cap = captureNext();
    const rec = pushNotification({
      userId: 'u1', kind: 'quota_limit', channel: 'both', severity: 'warn',
      title: '配额超限', body: '50/50', payload: { resource: 'agent' },
    });
    const ev = await cap.promise;
    cap.sub.unsubscribe();

    expect(ev.type).toBe('notification.delivered');
    expect(ev.notificationId).toBe(rec.id);
    expect(ev.title).toBe('配额超限');
    expect(ev.body).toBe('50/50');
    expect(ev.channel).toBe('both');
    expect(ev.kind).toBe('quota_limit');
    expect(ev.severity).toBe('warn');
    expect(ev.payload).toEqual({ resource: 'agent' });
    expect(ev.target).toEqual({ kind: 'user', id: 'u1' });
    // makeBase 填的基础字段
    expect(ev.source).toBe('notification-center');
    expect(typeof ev.eventId).toBe('string');
    expect(typeof ev.ts).toBe('string');
  });

  it('userId=null 时 target.id 退化为 "local"', async () => {
    const cap = captureNext();
    pushNotification({
      userId: null, kind: 'system', channel: 'in_app', severity: 'info',
      title: 't', body: 'b', payload: {},
    });
    const ev = await cap.promise;
    cap.sub.unsubscribe();
    expect(ev.target).toEqual({ kind: 'user', id: 'local' });
  });

  it('带 sourceEventType/sourceEventId 时原样透传', async () => {
    const cap = captureNext();
    pushNotification({
      userId: 'u1', kind: 'agent_error', channel: 'system', severity: 'error',
      title: 'err', body: 'oops', payload: {},
      sourceEventType: 'driver.error', sourceEventId: 'evt-7',
    });
    const ev = await cap.promise;
    cap.sub.unsubscribe();
    expect(ev.sourceEventType).toBe('driver.error');
    expect(ev.sourceEventId).toBe('evt-7');
  });
});
