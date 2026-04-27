import { describe, test, expect } from 'bun:test';
import { createTicker } from './ticker.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('ticker', () => {
  test('schedule + 到时触发', async () => {
    const ticker = createTicker();
    let fired = 0;
    ticker.schedule({
      id: 'a',
      fireAt: Date.now() + 30,
      callback: () => {
        fired++;
      },
    });
    expect(ticker.size()).toBe(1);
    await sleep(80);
    expect(fired).toBe(1);
    expect(ticker.size()).toBe(0);
    ticker.destroy();
  });

  test('多任务按时间顺序触发', async () => {
    const ticker = createTicker();
    const order: string[] = [];
    ticker.schedule({
      id: 'late',
      fireAt: Date.now() + 60,
      callback: () => order.push('late'),
    });
    ticker.schedule({
      id: 'early',
      fireAt: Date.now() + 20,
      callback: () => order.push('early'),
    });
    await sleep(120);
    expect(order).toEqual(['early', 'late']);
    ticker.destroy();
  });

  test('cancel 后不触发', async () => {
    const ticker = createTicker();
    let fired = 0;
    ticker.schedule({
      id: 'x',
      fireAt: Date.now() + 30,
      callback: () => {
        fired++;
      },
    });
    ticker.cancel('x');
    expect(ticker.size()).toBe(0);
    await sleep(80);
    expect(fired).toBe(0);
    ticker.destroy();
  });

  test('reschedule 改时间', async () => {
    const ticker = createTicker();
    const firedAt: number[] = [];
    const start = Date.now();
    ticker.schedule({
      id: 'r',
      fireAt: start + 200,
      callback: () => firedAt.push(Date.now() - start),
    });
    ticker.reschedule('r', start + 30);
    await sleep(100);
    expect(firedAt.length).toBe(1);
    expect(firedAt[0]).toBeLessThan(100);
    ticker.destroy();
  });

  test('repeat 任务自动重新调度', async () => {
    const ticker = createTicker();
    let fired = 0;
    ticker.schedule({
      id: 'rep',
      fireAt: Date.now() + 20,
      repeat: 30,
      callback: () => {
        fired++;
      },
    });
    await sleep(130);
    ticker.cancel('rep');
    expect(fired).toBeGreaterThanOrEqual(2);
    ticker.destroy();
  });

  test('event loop 阻塞后醒来批量触发', async () => {
    const ticker = createTicker();
    let a = 0;
    let b = 0;
    const now = Date.now();
    ticker.schedule({
      id: 'a',
      fireAt: now + 10,
      callback: () => {
        a++;
      },
    });
    ticker.schedule({
      id: 'b',
      fireAt: now + 20,
      callback: () => {
        b++;
      },
    });
    // 同步阻塞 50ms，模拟 event loop 卡住
    const stuckUntil = Date.now() + 50;
    while (Date.now() < stuckUntil) {
      /* busy wait */
    }
    await sleep(30);
    expect(a).toBe(1);
    expect(b).toBe(1);
    ticker.destroy();
  });

  test('destroy 后清空', () => {
    const ticker = createTicker();
    ticker.schedule({
      id: 'x',
      fireAt: Date.now() + 1000,
      callback: () => {},
    });
    expect(ticker.size()).toBe(1);
    ticker.destroy();
    expect(ticker.size()).toBe(0);
  });

  test('callback 抛错不影响其他任务', async () => {
    const ticker = createTicker();
    let good = 0;
    ticker.schedule({
      id: 'bad',
      fireAt: Date.now() + 20,
      callback: () => {
        throw new Error('boom');
      },
    });
    ticker.schedule({
      id: 'good',
      fireAt: Date.now() + 20,
      callback: () => {
        good++;
      },
    });
    await sleep(80);
    expect(good).toBe(1);
    ticker.destroy();
  });

  test('size() 随 schedule/cancel 变化', () => {
    const ticker = createTicker();
    expect(ticker.size()).toBe(0);
    ticker.schedule({ id: '1', fireAt: Date.now() + 1000, callback: () => {} });
    ticker.schedule({ id: '2', fireAt: Date.now() + 2000, callback: () => {} });
    expect(ticker.size()).toBe(2);
    ticker.cancel('1');
    expect(ticker.size()).toBe(1);
    ticker.destroy();
  });
});
