// domain-sync subscriber 集成测：当前 subscriber 为空壳（Stage 3 W2-3 清扫后），
// 原 pty.spawned → setSessionPid 已下线，新 driver-based pid 回写由 W2-1c 接管。
// 这里只保留对 subscribeDomainSync 的基本契约断言，确保它仍可安全装配 / 卸载。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from '../bus/events.js';
import { subscribeDomainSync } from '../bus/subscribers/domain-sync.subscriber.js';
import { closeDb, getDb } from '../db/connection.js';

let bus: EventBus;
let sub: { unsubscribe(): void };

beforeEach(() => {
  closeDb();
  getDb();
  bus = new EventBus();
  sub = subscribeDomainSync(bus);
});

afterEach(() => {
  sub.unsubscribe();
  bus.destroy();
  closeDb();
});

describe('subscribeDomainSync', () => {
  it('subscribe + unsubscribe 不抛', () => {
    expect(typeof sub.unsubscribe).toBe('function');
  });
});
