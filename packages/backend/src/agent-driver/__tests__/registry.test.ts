// DriverRegistry 单测：纯 Map 行为，不 mock 任何东西。
// 用最小 fake driver（只需满足 AgentDriver 类型，实现细节无关），保证测试聚焦在 Map 语义。
import { describe, it, expect, beforeEach } from 'bun:test';
import type { AgentDriver } from '../driver.js';
import { DriverRegistry, driverRegistry } from '../registry.js';

function fakeDriver(id: string): AgentDriver {
  return { id } as unknown as AgentDriver;
}

describe('DriverRegistry', () => {
  let reg: DriverRegistry;
  beforeEach(() => {
    reg = new DriverRegistry();
  });

  it('register + get 取得同一引用', () => {
    const d = fakeDriver('a');
    reg.register('a', d);
    expect(reg.get('a')).toBe(d);
  });

  it('get 未注册时返回 undefined', () => {
    expect(reg.get('missing')).toBeUndefined();
  });

  it('unregister 之后 get 返回 undefined', () => {
    reg.register('a', fakeDriver('a'));
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
  });

  it('unregister 不存在的 key 不抛错', () => {
    expect(() => reg.unregister('nope')).not.toThrow();
  });

  it('重复 register 同一 id 后 get 返回最新', () => {
    const d1 = fakeDriver('a');
    const d2 = fakeDriver('a');
    reg.register('a', d1);
    reg.register('a', d2);
    expect(reg.get('a')).toBe(d2);
    expect(reg.get('a')).not.toBe(d1);
  });

  it('list 返回所有已注册 driver', () => {
    const d1 = fakeDriver('a');
    const d2 = fakeDriver('b');
    reg.register('a', d1);
    reg.register('b', d2);
    const all = reg.list();
    expect(all).toHaveLength(2);
    expect(all).toContain(d1);
    expect(all).toContain(d2);
  });

  it('list 空 registry 返回 []', () => {
    expect(reg.list()).toEqual([]);
  });

  it('clear 清空所有条目', () => {
    reg.register('a', fakeDriver('a'));
    reg.register('b', fakeDriver('b'));
    reg.clear();
    expect(reg.list()).toEqual([]);
    expect(reg.get('a')).toBeUndefined();
  });

  it('多次 unregister 幂等', () => {
    reg.register('a', fakeDriver('a'));
    reg.unregister('a');
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
  });
});

describe('driverRegistry (进程级单例)', () => {
  it('导出的是 DriverRegistry 实例', () => {
    expect(driverRegistry).toBeInstanceOf(DriverRegistry);
  });

  it('单例全局一致：register 后在任何 import 点都看得到', () => {
    const d = fakeDriver('singleton');
    driverRegistry.register('singleton', d);
    try {
      expect(driverRegistry.get('singleton')).toBe(d);
    } finally {
      driverRegistry.unregister('singleton');
    }
  });
});
