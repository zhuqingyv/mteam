// Phase 4 T3.2 · ActionItemScheduler 单测。
// 不 mock：真 Ticker 实例（createTicker）+ :memory: DB + fake notify 收集器。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { closeDb, getDb } from '../db/connection.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';
import { createTicker } from '../ticker/ticker.js';
import { createItem, findById, resolve, updateStatus } from './repo.js';
import { ActionItemScheduler } from './scheduler.js';

const USER = { kind: 'user' as const, id: 'alice' };
const AGENT = { kind: 'agent' as const, id: 'agent-1' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup() {
  const ticker = createTicker();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));
  const notified: Array<{ to: string; message: string }> = [];
  const notify = (to: string, message: string) => { notified.push({ to, message }); };
  const scheduler = new ActionItemScheduler(ticker, bus, notify);
  return { ticker, bus, events, notified, scheduler };
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('ActionItemScheduler', () => {
  it('boot 扫 pending 项注册 reminder + timeout 两个 ticker 任务', () => {
    const { ticker, scheduler } = setup();
    createItem({ id: 'b1', kind: 'task', title: 't', creator: USER, assignee: AGENT, deadline: Date.now() + 10 * 60_000 });
    scheduler.boot();
    expect(ticker.size()).toBe(2);
    scheduler.teardown();
    expect(ticker.size()).toBe(0);
  });

  it('reminder 触发：调 notify(assignee) + 更新 remindedAt + emit reminder', async () => {
    const { events, notified, scheduler } = setup();
    // span=300ms < 60s 走 fallback，fireAt=now+1 立即触发；二次确认未命中时自动 reschedule 到真正的 10% 窗口 (deadline-30ms)。
    const item = createItem({ id: 'r1', kind: 'task', title: 'review', creator: USER, assignee: AGENT, deadline: Date.now() + 300 });
    scheduler.onItemCreated(item);
    await sleep(340);
    expect(notified.some((n) => n.to === AGENT.id && n.message.includes('review'))).toBe(true);
    expect(findById('r1')!.remindedAt).not.toBeNull();
    expect(events.some((e) => e.type === 'action_item.reminder')).toBe(true);
    scheduler.teardown();
  });

  it('timeout 触发：status → timeout，notify creator，emit timeout', async () => {
    const { events, notified, scheduler } = setup();
    const item = createItem({ id: 'to1', kind: 'task', title: 'ship', creator: USER, assignee: AGENT, deadline: Date.now() + 60 });
    scheduler.onItemCreated(item);
    await sleep(150);
    expect(findById('to1')!.status).toBe('timeout');
    expect(notified.some((n) => n.to === USER.id && n.message.includes('ship'))).toBe(true);
    expect(events.some((e) => e.type === 'action_item.timeout')).toBe(true);
    scheduler.teardown();
  });

  it('onItemResolved 后 ticker 任务被 cancel', () => {
    const { ticker, scheduler } = setup();
    const item = createItem({ id: 'res1', kind: 'task', title: 't', creator: USER, assignee: AGENT, deadline: Date.now() + 100_000 });
    scheduler.onItemCreated(item);
    expect(ticker.size()).toBe(2);
    resolve('res1', 'done');
    scheduler.onItemResolved('res1');
    expect(ticker.size()).toBe(0);
    scheduler.teardown();
  });

  it('短 deadline（<60s）fallback：reminder 在 10% 窗口正确触发', async () => {
    const { notified, scheduler } = setup();
    // span=250ms<60s 走 fallback。windowStart = deadline - 25ms；二次确认未命中时 reschedule 到 windowStart。
    const item = createItem({ id: 's1', kind: 'task', title: 'quick', creator: USER, assignee: AGENT, deadline: Date.now() + 250 });
    scheduler.onItemCreated(item);
    await sleep(290);
    expect(notified.some((n) => n.to === AGENT.id && n.message.includes('quick'))).toBe(true);
    scheduler.teardown();
  });

  it('已 resolved 的 item boot 时不注册', () => {
    const { ticker, scheduler } = setup();
    createItem({ id: 'd1', kind: 'task', title: 't', creator: USER, assignee: AGENT, deadline: Date.now() + 100_000 });
    updateStatus('d1', 'done');
    scheduler.boot();
    expect(ticker.size()).toBe(0);
  });
});
