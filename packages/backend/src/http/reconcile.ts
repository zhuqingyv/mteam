import { RoleInstance } from '../domain/role-instance.js';

// 启动时清理上次崩溃遗留的 zombie 实例：
// - 有 sessionPid 但进程已死 → delete
// - 无 sessionPid 的老实例 → delete
export function reconcileStaleInstances(): void {
  const stale = RoleInstance.listAll();
  for (const inst of stale) {
    if (inst.sessionPid) {
      try {
        process.kill(inst.sessionPid, 0);
      } catch {
        process.stderr.write(
          `[v2] reconcile: removing zombie instance ${inst.id} (pid=${inst.sessionPid} gone)\n`,
        );
        inst.delete();
      }
    } else {
      process.stderr.write(
        `[v2] reconcile: removing zombie instance ${inst.id} (no session_pid)\n`,
      );
      inst.delete();
    }
  }
}
