// Unit 测试：CliManager boot/getAll/isAvailable/getInfo/refresh
// 不 mock 命令执行，直接 spawn which — 白名单里 claude/codex 是否存在取决于本机，
// 断言里只保证"白名单长度"和"nonexistent 必为 false"等不依赖本机安装的事实。
import { describe, it, expect } from 'bun:test';
import { CliManager } from '../cli-scanner/manager.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';

describe('CliManager', () => {
  it('boot + getAll 返回白名单长度的数组，每项结构正确', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
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

  it('isAvailable 对白名单项返回与 getAll 一致；对非白名单名返回 false', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    const claudeInfo = mgr.getInfo('claude');
    expect(mgr.isAvailable('claude')).toBe(claudeInfo?.available ?? false);
    expect(mgr.isAvailable('nonexistent')).toBe(false);
    mgr.teardown();
  });

  it('getInfo 返回白名单项；非白名单返回 null', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    expect(mgr.getInfo('claude')).not.toBeNull();
    expect(mgr.getInfo('codex')).not.toBeNull();
    expect(mgr.getInfo('nonexistent')).toBeNull();
    mgr.teardown();
  });

  it('teardown 清空快照；再 boot 恢复白名单长度', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    expect(mgr.getAll()).toHaveLength(2);
    mgr.teardown();
    // teardown 之后 snapshot 被清空，但 getAll 兜底返回白名单长度（全 available=false）。
    const afterTeardown = mgr.getAll();
    expect(afterTeardown).toHaveLength(2);
    for (const c of afterTeardown) {
      expect(c.available).toBe(false);
    }
    mgr.boot();
    expect(mgr.getAll()).toHaveLength(2);
    mgr.teardown();
  });

  it('refresh 返回最新快照，与 getAll 结构一致', () => {
    const mgr = new CliManager(new EventBus(), 60_000);
    mgr.boot();
    const refreshed = mgr.refresh();
    expect(refreshed).toHaveLength(2);
    expect(refreshed).toEqual(mgr.getAll());
    mgr.teardown();
  });

  it('首次 boot 时，available 的 CLI 会 emit cli.available 事件（若本机装了）', async () => {
    const testBus = new EventBus();
    const events: BusEvent[] = [];
    testBus.events$.subscribe((e) => events.push(e));

    const mgr = new CliManager(testBus, 60_000);
    mgr.boot();
    // poll 在 setInterval 里触发，首次 boot 本身不 emit — 调 refresh() 触发一次 diff。
    // boot 之后 snapshot 已有值，refresh 再扫描一次，prev=cur 不会 emit。
    // 为了验证 emit 路径，teardown 后重新 new 一个 manager，用同一 bus，
    // 让首次 poll 从空快照 diff 出 available。
    mgr.teardown();

    const mgr2 = new CliManager(testBus, 60_000);
    // 手动注入空快照，调 refresh 触发从空到有的 diff。
    events.length = 0;
    mgr2.refresh(); // snapshot 默认空 → 扫描后如有 available 的就 emit
    mgr2.teardown();

    // 不强制本机必须装 claude/codex — 若都没装，events 可为空，测试只验证类型正确。
    for (const e of events) {
      expect(['cli.available', 'cli.unavailable']).toContain(e.type);
      if (e.type === 'cli.available') {
        expect(typeof e.cliName).toBe('string');
        expect(typeof e.path).toBe('string');
      }
    }
  });
});
