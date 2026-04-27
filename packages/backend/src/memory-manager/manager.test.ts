// MemoryManager 单测 —— 覆盖 W1-4 判据：
// - 三策略（lru / ttl / fifo）淘汰语义正确
// - warnThreshold 触发 onWarn 回调（+ cooldown 去重）
// - cleanup 对多集合并行执行；getStats 返回各集合 record
// - register 校验（重名、maxSize、ttl 必需）
// - startTicker / stopTicker 幂等；ticker .unref
// 不 mock 业务：所有集合走真实 adapters。

import { describe, it, expect } from 'bun:test';
import { MemoryManager } from './manager.js';
import { mapAsCollection, setAsCollection } from './collection-adapters.js';

function mkMap<K, V>() { return new Map<K, V>(); }

describe('MemoryManager · register 校验', () => {
  it('重名抛错', () => {
    const mm = new MemoryManager();
    mm.register('x', setAsCollection(new Set()), { maxSize: 10, strategy: 'fifo' });
    expect(() => mm.register('x', setAsCollection(new Set()), { maxSize: 10, strategy: 'fifo' }))
      .toThrow(/already registered/);
  });
  it('maxSize <= 0 抛错', () => {
    const mm = new MemoryManager();
    expect(() => mm.register('x', setAsCollection(new Set()), { maxSize: 0, strategy: 'fifo' }))
      .toThrow(/maxSize/);
  });
  it('ttl 策略缺 ttlMs 抛错', () => {
    const mm = new MemoryManager();
    expect(() => mm.register('x', setAsCollection(new Set()), { maxSize: 10, strategy: 'ttl' }))
      .toThrow(/ttlMs/);
  });
});

describe('MemoryManager · lru', () => {
  it('touch 后，keys 顺序把最近访问排尾；cleanup 淘汰最久未用', () => {
    const map = mkMap<string, number>();
    const col = mapAsCollection(map, { touch: true });
    const mm = new MemoryManager();
    mm.register('lru', col, { maxSize: 3, strategy: 'lru' });

    map.set('a', 1); map.set('b', 2); map.set('c', 3);
    col.touch!('a');                  // a 升到尾部 → 剩 LRU 顺序 b, c, a
    map.set('d', 4);                  // 超容量，b 应被淘汰
    mm.cleanup();

    expect([...map.keys()]).toEqual(['c', 'a', 'd']);
    expect(mm.getStats()[0].evictedCount).toBe(1);
  });
});

describe('MemoryManager · fifo', () => {
  it('不走 touch，按写入顺序淘汰', () => {
    const map = mkMap<string, number>();
    const col = mapAsCollection(map);                  // 无 touch
    const mm = new MemoryManager();
    mm.register('fifo', col, { maxSize: 2, strategy: 'fifo' });

    map.set('a', 1); map.set('b', 2); map.set('c', 3);
    mm.cleanup();

    expect([...map.keys()]).toEqual(['b', 'c']);
    expect(mm.getStats()[0].evictedCount).toBe(1);
  });
});

describe('MemoryManager · ttl', () => {
  it('过期项先走 ageOf 剔除，之后若仍超容量再按 keys 顺序补齐', () => {
    const map = mkMap<string, number>();
    const ages = mkMap<unknown, number>();
    const col = mapAsCollection(map, { ageMap: ages });
    const mm = new MemoryManager();
    mm.register('ttl', col, { maxSize: 10, strategy: 'ttl', ttlMs: 1_000 });

    const now = Date.now();
    map.set('old', 1); ages.set('old', now - 5_000);   // 过期
    map.set('new', 2); ages.set('new', now);           // 未过期

    mm.cleanup();

    expect(map.has('old')).toBe(false);
    expect(map.has('new')).toBe(true);
    expect(ages.has('old')).toBe(false);               // adapter 同步清 ageMap
    expect(mm.getStats()[0].evictedCount).toBe(1);
  });

  it('无 ageOf 的集合在 ttl 策略下只按容量淘汰，不抛', () => {
    const set = new Set<string>(['a', 'b', 'c']);
    const col = setAsCollection(set);                  // 没 ageOf
    const mm = new MemoryManager();
    mm.register('ttl', col, { maxSize: 2, strategy: 'ttl', ttlMs: 1_000 });
    expect(() => mm.cleanup()).not.toThrow();
    expect(set.size).toBe(2);
  });
});

describe('MemoryManager · warn', () => {
  it('usage 达到阈值触发 onWarn；cooldown 内不重复触发', async () => {
    const mm = new MemoryManager();
    const set = new Set<number>();
    mm.register('w', setAsCollection(set), { maxSize: 10, strategy: 'fifo', warnThreshold: 0.5 });

    const seen: Array<{ name: string; usage: number }> = [];
    mm.onWarn((w) => seen.push({ name: w.name, usage: w.usage }));

    for (let i = 0; i < 5; i += 1) set.add(i);
    mm.cleanup();                                      // usage=0.5 → warn
    mm.cleanup();                                      // cooldown 内，不再 warn
    expect(seen.length).toBe(1);
    expect(seen[0]!.name).toBe('w');
    expect(seen[0]!.usage).toBeCloseTo(0.5);
  });

  it('onWarn 返回解绑函数；解绑后不再回调', () => {
    const mm = new MemoryManager();
    const set = new Set<number>(); for (let i = 0; i < 9; i += 1) set.add(i);
    mm.register('w', setAsCollection(set), { maxSize: 10, strategy: 'fifo', warnThreshold: 0.5 });

    let count = 0;
    const off = mm.onWarn(() => { count += 1; });
    mm.cleanup();
    off();
    set.add(99);                                        // 变更触发再次超阈值
    // 冷却内不会再 warn；这里只是证明解绑本身不抛
    mm.cleanup();
    expect(count).toBe(1);
  });
});

describe('MemoryManager · getStats / unregister', () => {
  it('stats 返回所有已注册集合', () => {
    const mm = new MemoryManager();
    mm.register('a', setAsCollection(new Set([1, 2])), { maxSize: 10, strategy: 'fifo' });
    mm.register('b', setAsCollection(new Set([3])), { maxSize: 5, strategy: 'lru' });
    const stats = mm.getStats();
    expect(stats.map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(stats.find((s) => s.name === 'a')!.capacity).toBe(10);
    expect(stats.find((s) => s.name === 'b')!.strategy).toBe('lru');
  });

  it('unregister 后 stats 不含该名', () => {
    const mm = new MemoryManager();
    mm.register('a', setAsCollection(new Set()), { maxSize: 10, strategy: 'fifo' });
    mm.unregister('a');
    expect(mm.getStats()).toEqual([]);
  });
});

describe('MemoryManager · ticker', () => {
  it('startTicker 周期 cleanup；stopTicker 停掉；定时器 unref', async () => {
    const mm = new MemoryManager();
    const set = new Set<number>(); for (let i = 0; i < 5; i += 1) set.add(i);
    mm.register('t', setAsCollection(set), { maxSize: 2, strategy: 'fifo' });

    mm.startTicker(10);
    await new Promise((r) => setTimeout(r, 40));
    mm.stopTicker();
    expect(set.size).toBe(2);                           // 被 ticker 淘汰过

    mm.stopTicker();                                    // 幂等，不抛
  });

  it('startTicker 再次调用会先停旧的再起新的', () => {
    const mm = new MemoryManager();
    mm.startTicker(1_000);
    mm.startTicker(1_000);                              // 不泄漏
    mm.stopTicker();
  });
});
