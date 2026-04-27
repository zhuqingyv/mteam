// adapters 单测 —— 证明 mapAsCollection / setAsCollection 无侵入。
import { describe, it, expect } from 'bun:test';
import { mapAsCollection, setAsCollection } from './collection-adapters.js';

describe('mapAsCollection', () => {
  it('不传 opts：size / evict / keys 透传 Map', () => {
    const map = new Map<string, number>([['a', 1], ['b', 2]]);
    const col = mapAsCollection(map);
    expect(col.size).toBe(2);
    expect([...col.keys()]).toEqual(['a', 'b']);
    col.evict('a');
    expect(map.has('a')).toBe(false);
    expect(col.touch).toBeUndefined();
    expect(col.ageOf).toBeUndefined();
  });

  it('touch: true → key 重写到 Map 尾部（LRU 所需顺序）', () => {
    const map = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]]);
    const col = mapAsCollection(map, { touch: true });
    col.touch!('a');
    expect([...map.keys()]).toEqual(['b', 'c', 'a']);
  });

  it('touch 不存在的 key 无副作用', () => {
    const map = new Map<string, number>([['a', 1]]);
    const col = mapAsCollection(map, { touch: true });
    col.touch!('zzz');
    expect([...map.keys()]).toEqual(['a']);
  });

  it('ageMap：evict 同步清 ageMap；ageOf 读 ageMap', () => {
    const map = new Map<string, number>();
    const ages = new Map<unknown, number>();
    const col = mapAsCollection(map, { ageMap: ages });
    map.set('a', 1); ages.set('a', 123);
    expect(col.ageOf!('a')).toBe(123);
    col.evict('a');
    expect(ages.has('a')).toBe(false);
  });
});

describe('setAsCollection', () => {
  it('透传 Set', () => {
    const set = new Set([1, 2, 3]);
    const col = setAsCollection(set);
    expect(col.size).toBe(3);
    expect([...col.keys()]).toEqual([1, 2, 3]);
    col.evict(2);
    expect(set.has(2)).toBe(false);
  });
});
