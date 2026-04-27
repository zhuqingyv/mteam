// 把现有 Map/Set 无侵入包成 Collection，供 MemoryManager 纳管。
// mapAsCollection 支持 { touch: true } 开 LRU：touch(k) 删后重写，让 keys()
//   尾部永远是最近访问的，头部自动成为 LRU 淘汰候选。
// mapAsCollection 支持 { ageMap } 外挂 TTL 时间戳表：写入时由调用方在 ageMap
//   里记录 Date.now()，本适配器负责在 evict 时清理 ageMap。
import type { Collection } from './manager.js';

export interface MapAdapterOpts {
  touch?: boolean;
  ageMap?: Map<unknown, number>;
}

export function mapAsCollection<K, V>(map: Map<K, V>, opts: MapAdapterOpts = {}): Collection<K> {
  const { touch, ageMap } = opts;
  const adapter: Collection<K> = {
    get size() { return map.size; },
    evict(key) {
      map.delete(key);
      ageMap?.delete(key);
    },
    keys() { return map.keys(); },
  };
  if (touch) adapter.touch = (key) => {
    if (!map.has(key)) return;
    const v = map.get(key) as V;
    map.delete(key);
    map.set(key, v);
  };
  if (ageMap) adapter.ageOf = (key) => ageMap.get(key);
  return adapter;
}

export function setAsCollection<T>(set: Set<T>): Collection<T> {
  return {
    get size() { return set.size; },
    evict(key) { set.delete(key); },
    keys() { return set.values(); },
  };
}
