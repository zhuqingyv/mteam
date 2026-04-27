// pid-writeback 单测 —— 不 mock db/bus。
// :memory: SQLite + 独立 EventBus，直接 emit driver.started 验证 session_pid 落盘。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import type { Subscription } from 'rxjs';
import { subscribePidWriteback } from './pid-writeback.js';
import { EventBus } from '../../events.js';
import { makeBase } from '../../helpers.js';
import { closeDb, getDb } from '../../../db/connection.js';
import { RoleTemplate } from '../../../domain/role-template.js';
import { RoleInstance } from '../../../domain/role-instance.js';

function resetDb(): void {
  closeDb();
  getDb();
  RoleTemplate.create({ name: 'coder', role: 'dev', persona: 'p' });
}

function seedMember(name = 'Alice'): RoleInstance {
  return RoleInstance.create({ templateName: 'coder', memberName: name, isLeader: false });
}

function emitStarted(bus: EventBus, driverId: string, pid?: number | string): void {
  bus.emit({
    ...makeBase('driver.started', 'test'),
    driverId,
    ...(pid !== undefined ? { pid } : {}),
  });
}

interface Ctx { bus: EventBus; sub: Subscription; }
function setup(): Ctx {
  const bus = new EventBus();
  const sub = subscribePidWriteback({ eventBus: bus });
  return { bus, sub };
}
function teardown(ctx: Ctx): void { ctx.sub.unsubscribe(); ctx.bus.destroy(); }

describe('pid-writeback', () => {
  beforeEach(() => resetDb());
  afterEach(() => closeDb());

  it('driver.started 带 pid → RoleInstance.session_pid 落盘', () => {
    const ctx = setup();
    const inst = seedMember();
    emitStarted(ctx.bus, inst.id, 12345);
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBe(12345);
    teardown(ctx);
  });

  it('driver.started 无 pid → 不写，保持 NULL', () => {
    const ctx = setup();
    const inst = seedMember();
    emitStarted(ctx.bus, inst.id);  // 不带 pid 字段
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBeNull();
    teardown(ctx);
  });

  it('driverId 非成员（primary_agent 或幽灵 id）→ 跳过，不抛错', () => {
    const ctx = setup();
    emitStarted(ctx.bus, 'primary-agent-xyz', 9999);
    // 只需断言不抛错；没有 RoleInstance 行可查，直接成功即可
    expect(getDb().prepare(`SELECT COUNT(*) AS c FROM role_instances`).get()).toEqual({ c: 0 });
    teardown(ctx);
  });

  it('pid 是字符串形式数字 → 解析并写入', () => {
    const ctx = setup();
    const inst = seedMember();
    emitStarted(ctx.bus, inst.id, '54321');
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBe(54321);
    teardown(ctx);
  });

  it('pid 是非数字字符串（未来容器化 id）→ 跳过，不写', () => {
    const ctx = setup();
    const inst = seedMember();
    emitStarted(ctx.bus, inst.id, 'container-abc');
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBeNull();
    teardown(ctx);
  });

  it('unsubscribe 后 driver.started 不再触发写入', () => {
    const ctx = setup();
    const inst = seedMember();
    ctx.sub.unsubscribe();
    emitStarted(ctx.bus, inst.id, 777);
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBeNull();
    ctx.bus.destroy();
  });

  it('同一 driverId 多次 started（重启场景）→ 以最新 pid 覆盖', () => {
    const ctx = setup();
    const inst = seedMember();
    emitStarted(ctx.bus, inst.id, 1000);
    emitStarted(ctx.bus, inst.id, 2000);
    expect(RoleInstance.findById(inst.id)!.sessionPid).toBe(2000);
    teardown(ctx);
  });
});
