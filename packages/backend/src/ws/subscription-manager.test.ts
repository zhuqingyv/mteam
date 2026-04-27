import { describe, it, expect } from 'bun:test';
import { SubscriptionManager, type ClientSubscription } from './subscription-manager.js';
import type { BusEvent } from '../bus/types.js';

// ---------- helpers ----------

function evt<T extends BusEvent>(e: T): T {
  return e;
}

const commSent = (from: string, to: string, messageId = 'm1'): BusEvent =>
  evt({
    type: 'comm.message_sent',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    messageId,
    from,
    to,
  });

const commRecv = (from: string, to: string, messageId = 'm1'): BusEvent =>
  evt({
    type: 'comm.message_received',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    messageId,
    from,
    to,
    route: 'socket',
  });

const teamMemberJoined = (teamId: string, instanceId: string): BusEvent =>
  evt({
    type: 'team.member_joined',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    teamId,
    instanceId,
    roleInTeam: null,
  });

const instanceCreated = (instanceId: string, teamId: string | null = null): BusEvent =>
  evt({
    type: 'instance.created',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    instanceId,
    templateName: 'tpl',
    memberName: 'm',
    isLeader: false,
    teamId,
    task: null,
  });

const driverText = (driverId: string): BusEvent =>
  evt({
    type: 'driver.text',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    driverId,
    content: 'hi',
  });

const cliAvailable = (): BusEvent =>
  evt({
    type: 'cli.available',
    ts: '2026-04-25T00:00:00Z',
    source: 'test',
    cliName: 'claude',
    path: '/usr/local/bin/claude',
    version: null,
  });

const sub = (scope: ClientSubscription['scope'], id: string | null): ClientSubscription => ({
  scope,
  id,
});

// ---------- tests ----------

describe('SubscriptionManager · 连接生命周期', () => {
  it('addConn 幂等：重复 add 不重置订阅', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('team', 't1'));
    m.addConn('c1'); // 再 add 一遍
    expect(m.list('c1')).toEqual([{ scope: 'team', id: 't1' }]);
  });

  it('removeConn 幂等：首次 true、二次 false', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    expect(m.removeConn('c1')).toBe(true);
    expect(m.removeConn('c1')).toBe(false);
  });

  it('未 addConn 就 subscribe 不抛错也不生效', () => {
    const m = new SubscriptionManager();
    m.subscribe('ghost', sub('team', 't1'));
    expect(m.list('ghost')).toEqual([]);
    expect(m.match('ghost', teamMemberJoined('t1', 'i1'))).toBe(false);
  });

  it('removeConn 后 match 一律 false', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('global', null));
    m.removeConn('c1');
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(false);
  });
});

describe('SubscriptionManager · subscribe / unsubscribe', () => {
  it('重复 subscribe 同一 scope+id 只记一次', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('team', 't1'));
    m.subscribe('c1', sub('team', 't1'));
    expect(m.list('c1')).toHaveLength(1);
    expect(m.stats()).toEqual({ conns: 1, totalSubs: 1 });
  });

  it('unsubscribe 未订阅过不抛错', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    expect(() => m.unsubscribe('c1', sub('team', 'tX'))).not.toThrow();
  });

  it('unsubscribe 后 match 该事件落空', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('team', 't1'));
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(true);
    m.unsubscribe('c1', sub('team', 't1'));
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(false);
  });

  it('global 订阅的 id 被忽略（即使调用方传了）', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    // id 传入也会被规范化为 global: 这个 key
    m.subscribe('c1', { scope: 'global', id: 'ignored' } as ClientSubscription);
    const listed = m.list('c1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({ scope: 'global', id: null });
  });
});

describe('SubscriptionManager · match 规则', () => {
  it('global 订阅吞任意事件', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('global', null));
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(true);
    expect(m.match('c1', driverText('iX'))).toBe(true);
    expect(m.match('c1', cliAvailable())).toBe(true);
    expect(m.match('c1', commSent('local:i1', 'user:u999'))).toBe(true);
  });

  it('instance:<id> 命中 driver.* （driverId）与 instance.created（instanceId）', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('instance', 'i1'));
    expect(m.match('c1', driverText('i1'))).toBe(true);
    expect(m.match('c1', instanceCreated('i1'))).toBe(true);
    // 反例：不同实例
    expect(m.match('c1', driverText('i2'))).toBe(false);
    expect(m.match('c1', instanceCreated('i2'))).toBe(false);
  });

  it('team:<id> 命中 team.* 与其他带 teamId 的事件', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('team', 't1'));
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(true);
    // 反例：不同 team
    expect(m.match('c1', teamMemberJoined('t2', 'i1'))).toBe(false);
    // 反例：无 teamId 的事件不命中 team 订阅
    expect(m.match('c1', driverText('i1'))).toBe(false);
  });

  it('user:<id> 命中 comm.* envelope.to=user:<id>', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('user', 'u1'));
    expect(m.match('c1', commSent('local:i1', 'user:u1'))).toBe(true);
    expect(m.match('c1', commRecv('local:i1', 'user:u1'))).toBe(true);
    // 反例：to 是其他 user
    expect(m.match('c1', commSent('local:i1', 'user:u2'))).toBe(false);
    // 反例：from 是 user:u1 但 to 不是 —— 不命中（设计上不回显）
    expect(m.match('c1', commSent('user:u1', 'local:i1'))).toBe(false);
    // 反例：本地 agent 互发
    expect(m.match('c1', commSent('local:i1', 'local:i2'))).toBe(false);
  });

  it('非 comm.* 的事件 user 订阅一律不命中', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('user', 'u1'));
    expect(m.match('c1', driverText('i1'))).toBe(false);
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(false);
  });

  it('空订阅集合一律 drop', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    expect(m.match('c1', teamMemberJoined('t1', 'i1'))).toBe(false);
  });

  it('global 与其他 scope 共存，global 依然吞', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('global', null));
    m.subscribe('c1', sub('team', 't1'));
    // 即便 team:t2 未订阅，global 也命中
    expect(m.match('c1', teamMemberJoined('t2', 'i1'))).toBe(true);
  });
});

describe('SubscriptionManager · 连接隔离', () => {
  it('A subscribe 不影响 B', () => {
    const m = new SubscriptionManager();
    m.addConn('A');
    m.addConn('B');
    m.subscribe('A', sub('team', 't1'));
    expect(m.match('A', teamMemberJoined('t1', 'i1'))).toBe(true);
    expect(m.match('B', teamMemberJoined('t1', 'i1'))).toBe(false);
    // B 订阅后仍隔离
    m.subscribe('B', sub('team', 't2'));
    expect(m.match('A', teamMemberJoined('t2', 'i1'))).toBe(false);
    expect(m.match('B', teamMemberJoined('t2', 'i1'))).toBe(true);
  });

  it('stats 汇总多连接订阅数', () => {
    const m = new SubscriptionManager();
    m.addConn('A');
    m.addConn('B');
    m.subscribe('A', sub('team', 't1'));
    m.subscribe('A', sub('team', 't2'));
    m.subscribe('B', sub('global', null));
    expect(m.stats()).toEqual({ conns: 2, totalSubs: 3 });
    m.removeConn('A');
    expect(m.stats()).toEqual({ conns: 1, totalSubs: 1 });
  });
});

describe('SubscriptionManager · list 返回拷贝', () => {
  it('list 返回的数组与内部 Set 解耦', () => {
    const m = new SubscriptionManager();
    m.addConn('c1');
    m.subscribe('c1', sub('team', 't1'));
    const a = m.list('c1');
    a.pop(); // 改返回值
    expect(m.list('c1')).toEqual([{ scope: 'team', id: 't1' }]); // 内部没被破坏
  });

  it('list 未知 connection 返回 []', () => {
    const m = new SubscriptionManager();
    expect(m.list('nope')).toEqual([]);
  });
});
