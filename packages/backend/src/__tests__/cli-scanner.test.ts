// Unit 测试：CliManager boot/getAll/isAvailable/getInfo/refresh
// 不 mock 命令执行，直接 spawn which — 白名单里 claude/codex 是否存在取决于本机，
// 断言里只保证"白名单长度"和"nonexistent 必为 false"等不依赖本机安装的事实。
//
// boot() 异步化后：boot() 立即返回，通过 ready() 等首次扫描完成。
import { describe, it, expect } from 'bun:test';
import { CliManager } from '../cli-scanner/manager.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';

describe('CliManager', () => {
  it('boot + await ready + getAll 返回白名单长度的数组，每项结构正确', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    await mgr.ready();
    const all = mgr.getAll();
    expect(all).toHaveLength(2);
    const names = all.map((c) => c.name).sort();
    expect(names).toEqual(['claude', 'codex']);
    for (const c of all) {
      expect(typeof c.available).toBe('boolean');
      if (c.available) {
        expect(typeof c.path).toBe('string');
      } else {
        expect(c.path).toBeNull();
        expect(c.version).toBeNull();
      }
    }
    mgr.teardown();
  });

  it('boot 之后 ready 之前，快照为空：isAvailable 白名单项一律 false', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    // 同步点：异步扫描还没完成，snapshot 空。
    expect(mgr.isAvailable('claude')).toBe(false);
    expect(mgr.isAvailable('codex')).toBe(false);
    // getAll 走白名单兜底，全 available=false。
    const all = mgr.getAll();
    expect(all).toHaveLength(2);
    for (const c of all) {
      expect(c.available).toBe(false);
      expect(c.path).toBeNull();
    }
    mgr.teardown();
  });

  it('isAvailable 对白名单项返回与 getAll 一致；对非白名单名返回 false', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    await mgr.ready();
    const claudeInfo = mgr.getInfo('claude');
    expect(mgr.isAvailable('claude')).toBe(claudeInfo?.available ?? false);
    expect(mgr.isAvailable('nonexistent')).toBe(false);
    mgr.teardown();
  });

  it('getInfo 返回白名单项；非白名单返回 null', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    await mgr.ready();
    expect(mgr.getInfo('claude')).not.toBeNull();
    expect(mgr.getInfo('codex')).not.toBeNull();
    expect(mgr.getInfo('nonexistent')).toBeNull();
    mgr.teardown();
  });

  it('teardown 清空快照；再 boot 恢复白名单长度', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    await mgr.ready();
    expect(mgr.getAll()).toHaveLength(2);
    mgr.teardown();
    // teardown 之后 snapshot 被清空，但 getAll 兜底返回白名单长度（全 available=false）。
    const afterTeardown = mgr.getAll();
    expect(afterTeardown).toHaveLength(2);
    for (const c of afterTeardown) {
      expect(c.available).toBe(false);
    }
    mgr.boot();
    await mgr.ready();
    expect(mgr.getAll()).toHaveLength(2);
    mgr.teardown();
  });

  it('refresh 返回最新快照，与 getAll 结构一致', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    await mgr.ready();
    const refreshed = await mgr.refresh();
    expect(refreshed).toHaveLength(2);
    expect(refreshed).toEqual(mgr.getAll());
    mgr.teardown();
  });

  it('首次扫描从空到有会 emit cli.available 事件（若本机装了）', async () => {
    const testBus = new EventBus();
    const events: BusEvent[] = [];
    testBus.events$.subscribe((e) => events.push(e));

    const mgr = new CliManager(testBus, 60_000);
    // 第一次 refresh：snapshot 默认空 → 扫描后如有 available 的就 emit
    await mgr.refresh();
    mgr.teardown();

    // 不强制本机必须装 claude/codex — 若都没装，events 可为空，测试只验证类型正确。
    for (const e of events) {
      expect(['cli.available', 'cli.unavailable']).toContain(e.type);
      if (e.type === 'cli.available') {
        expect(typeof e.cliName).toBe('string');
        expect(typeof e.path).toBe('string');
      }
    }
  });

  it('ready() 多次调用返回同一个 promise（boot 幂等）', async () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    const p1 = mgr.ready();
    mgr.boot(); // 幂等，不应触发第二次扫描
    const p2 = mgr.ready();
    expect(p1).toBe(p2);
    await p1;
    mgr.teardown();
  });
});
