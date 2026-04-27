// MemoryManager —— 进程级集合容量治理。纯净：不 import bus/domain/db/http/comm。
// 水位告警通过 onWarn 回调暴露，由上层决定是否 emit 总线事件。
// Collection: size / evict(k) / keys() 必需；touch(k) 可选供 LRU 使用；
//   ageOf(k) 返回写入时毫秒时间戳，供 TTL 使用。
// 策略：'lru' 按 keys() 头部淘汰（Map 自然插入序 + touch 重写实现 LRU）；
//   'fifo' 同上但不提供 touch；'ttl' 先扫过期再补齐容量。

export interface Collection<K = unknown> {
  readonly size: number;
  evict(key: K): void;
  keys(): IterableIterator<K>;
  touch?(key: K): void;
  ageOf?(key: K): number | undefined;
}

export type EvictStrategy = 'lru' | 'ttl' | 'fifo';

export interface CollectionOpts {
  maxSize: number;
  ttlMs?: number;
  strategy: EvictStrategy;
  warnThreshold?: number;
}

export interface CollectionStat {
  name: string;
  size: number;
  capacity: number;
  strategy: EvictStrategy;
  evictedCount: number;
}

export interface MemoryWarn {
  name: string;
  size: number;
  capacity: number;
  usage: number;
}

interface Entry {
  name: string;
  collection: Collection<unknown>;
  opts: Required<Pick<CollectionOpts, 'maxSize' | 'strategy' | 'warnThreshold'>> & {
    ttlMs?: number;
  };
  evictedCount: number;
  lastWarnedAt: number;
}

const DEFAULT_WARN_THRESHOLD = 0.8;
const WARN_COOLDOWN_MS = 5_000;

export class MemoryManager {
  private readonly entries = new Map<string, Entry>();
  private readonly warnListeners = new Set<(w: MemoryWarn) => void>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  register<K>(name: string, collection: Collection<K>, opts: CollectionOpts): void {
    if (this.entries.has(name)) throw new Error(`MemoryManager: '${name}' already registered`);
    if (opts.maxSize <= 0) throw new Error(`MemoryManager: maxSize must be > 0`);
    if (opts.strategy === 'ttl' && !opts.ttlMs) {
      throw new Error(`MemoryManager: ttl strategy requires ttlMs`);
    }
    this.entries.set(name, {
      name,
      collection: collection as Collection<unknown>,
      opts: {
        maxSize: opts.maxSize,
        strategy: opts.strategy,
        warnThreshold: opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD,
        ttlMs: opts.ttlMs,
      },
      evictedCount: 0,
      lastWarnedAt: 0,
    });
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  onWarn(listener: (w: MemoryWarn) => void): () => void {
    this.warnListeners.add(listener);
    return () => this.warnListeners.delete(listener);
  }

  getStats(): CollectionStat[] {
    return Array.from(this.entries.values(), (e) => ({
      name: e.name,
      size: e.collection.size,
      capacity: e.opts.maxSize,
      strategy: e.opts.strategy,
      evictedCount: e.evictedCount,
    }));
  }

  cleanup(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) this.sweepOne(entry, now);
  }

  startTicker(intervalMs: number): void {
    this.stopTicker();
    this.ticker = setInterval(() => this.cleanup(), intervalMs);
    this.ticker.unref?.();
  }

  stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private sweepOne(entry: Entry, now: number): void {
    const { collection, opts } = entry;

    if (opts.strategy === 'ttl' && opts.ttlMs && collection.ageOf) {
      const deadline = now - opts.ttlMs;
      const expired: unknown[] = [];
      for (const k of collection.keys()) {
        const age = collection.ageOf(k);
        if (age !== undefined && age <= deadline) expired.push(k);
      }
      for (const k of expired) {
        collection.evict(k);
        entry.evictedCount += 1;
      }
    }

    while (collection.size > opts.maxSize) {
      const first = collection.keys().next();
      if (first.done) break;
      collection.evict(first.value);
      entry.evictedCount += 1;
    }

    const usage = collection.size / opts.maxSize;
    if (usage >= opts.warnThreshold && now - entry.lastWarnedAt >= WARN_COOLDOWN_MS) {
      entry.lastWarnedAt = now;
      const warn: MemoryWarn = { name: entry.name, size: collection.size, capacity: opts.maxSize, usage };
      for (const l of this.warnListeners) l(warn);
    }
  }
}
