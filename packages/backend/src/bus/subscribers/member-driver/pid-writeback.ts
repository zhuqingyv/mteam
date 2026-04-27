// member-driver / pid-writeback —— 成员 driver 起来后把 runtime pid 写回 DB。
//
// 订阅 driver.started（含 pid 字段，见 bus/types.ts DriverStartedEvent）。
// driverId === RoleInstance.id（约定见 TASK-LIST §1.1），不是 role_instance 的
// 事件（如 primary_agent driver）→ findById 返回 null → 跳过。
//
// 为什么不依赖 registry：lifecycle 在 driver.start() 成功后才 registry.register()，
// 而 driver.started 是 start() 内部同步 emit 的，两者存在微小时序错位；直接走
// bus payload + DB 查询最鲁棒。设计文档：TASK-LIST §3 (W2-1c)。
import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../../events.js';
import { RoleInstance } from '../../../domain/role-instance.js';

export interface SubscribePidWritebackDeps {
  eventBus?: EventBus;
}

export function subscribePidWriteback(deps: SubscribePidWritebackDeps = {}): Subscription {
  const eventBus = deps.eventBus ?? defaultBus;
  return eventBus.on('driver.started').subscribe((e) => {
    if (e.pid === undefined) return;  // 极端失败路径：RuntimeHandle 没 pid，留 NULL
    const pidNum = typeof e.pid === 'number' ? e.pid : Number(e.pid);
    if (!Number.isFinite(pidNum)) return;  // 非数字 pid（未来容器化 id）暂不写回，留 debug
    const inst = RoleInstance.findById(e.driverId);
    if (!inst) return;  // primary_agent 或其他 driverId → 非成员，跳过
    try {
      inst.setSessionPid(pidNum);
    } catch (err) {
      process.stderr.write(
        `[member-driver/pid-writeback] setSessionPid failed ${e.driverId}: ${(err as Error).message}\n`,
      );
    }
  });
}
