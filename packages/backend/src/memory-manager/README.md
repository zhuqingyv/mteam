# memory-manager

进程级集合容量治理。把现有的 `Map` / `Set` 无侵入地纳管起来，按 LRU / TTL /
FIFO 策略做容量淘汰，超过水位时通过回调告警（不 import bus，调用方自己决定
要不要 emit 总线事件）。

本模块属于 Wave 1 · 非业务。**不允许** import `bus / domain / db / http /
comm / agent-driver` 等任何业务层代码。

## 契约

```ts
interface Collection<K> {
  readonly size: number;
  evict(key: K): void;
  keys(): IterableIterator<K>;
  touch?(key: K): void;           // 可选。LRU 策略下每次访问时由调用方触发。
  ageOf?(key: K): number | undefined;  // 可选。TTL 策略下返回写入毫秒时间戳。
}

interface CollectionOpts {
  maxSize: number;
  ttlMs?: number;                  // strategy='ttl' 时必填。
  strategy: 'lru' | 'ttl' | 'fifo';
  warnThreshold?: number;          // 0-1，默认 0.8。
}

class MemoryManager {
  register<K>(name: string, collection: Collection<K>, opts: CollectionOpts): void;
  unregister(name: string): void;
  onWarn(listener: (w: MemoryWarn) => void): () => void;  // 返回解绑函数。
  getStats(): CollectionStat[];
  cleanup(): void;
  startTicker(intervalMs: number): void;   // 定时器 .unref()，不阻塞退出。
  stopTicker(): void;
}
```

## 策略

| strategy | 淘汰顺序 | 需要适配器提供 |
|---|---|---|
| `lru` | `keys()` 头部（最久未访问） | `touch(k)` 在命中时把 key 重写到 Map 尾部 |
| `fifo` | `keys()` 头部（最早写入） | 仅 `size / evict / keys` |
| `ttl` | 先按 `ageOf(k) + ttlMs < now` 剔除；若仍超容量再按 `keys()` 顺序补齐 | `ageOf(k)` 外挂 ageMap 表 |

## 适配器

```ts
mapAsCollection(map, { touch?: boolean, ageMap?: Map<unknown, number> })
setAsCollection(set)
```

- `touch: true` → 产出的 `Collection.touch` 会把 key 从 Map 删除再重写到尾部，
  让 `keys()` 自然形成 LRU 顺序。调用方在**每次命中读/写**时调 `col.touch(k)`。
- `ageMap` → 写入时调用方自己在 ageMap 里存 `Date.now()`；adapter 负责在 `evict`
  时同步清理 ageMap，避免内存泄漏到时间戳表里。

## 单例

```ts
import { memoryManager } from './memory-manager/index.js';
```

`import` 本模块**不**起 ticker。由业务入口（一般是 `http/server.ts` 启动段）
显式调 `memoryManager.startTicker(30_000)` 起定时淘汰。

## 典型接线

```ts
import { memoryManager, mapAsCollection, setAsCollection } from './memory-manager/index.js';

// LRU：driver 注册表
memoryManager.register(
  'driverRegistry',
  mapAsCollection(this.map, { touch: true }),
  { maxSize: 200, strategy: 'lru' },
);

// FIFO：WS 连接池
memoryManager.register(
  'wsConns',
  setAsCollection(this.conns),
  { maxSize: 500, strategy: 'fifo' },
);

// TTL：turn 历史（24h）
const ageMap = new Map<unknown, number>();
memoryManager.register(
  'turnHistory',
  mapAsCollection(this.history, { ageMap }),
  { maxSize: 1000, strategy: 'ttl', ttlMs: 24 * 60 * 60 * 1000 },
);

// 水位告警桥接到 bus（业务层做，模块本身不依赖 bus）
memoryManager.onWarn((w) => bus.emit({ type: 'memory.warn', ...w }));
```

## 告警冷却

同一集合 `usage >= warnThreshold` 时触发 `onWarn`；5 秒内不会重复触发，避免刷屏。

## 验证

```bash
bun test src/memory-manager/
# 19 pass, 0 fail
```
