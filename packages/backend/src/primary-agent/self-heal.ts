// W2-3 · 自愈辅助：包一个独立的 RestartPolicy + 定时器句柄，供 PrimaryAgent 使用。
// 物理隔离于 container.subscriber 的 policy（S4 要求不共享计数 map）。
// 设计上只持有 policy + timer，决策语义由调用方消化（emit / stderr / setTimeout → restart）。
import { createRestartPolicy, type RestartPolicy, type RestartDecision } from '../bus/subscribers/container-restart-policy.js';

export interface SelfHeal {
  readonly policy: RestartPolicy;
  /** 返回 onCrash 决策；restart 分支需要调用方自己 schedule。 */
  onCrash(agentId: string): RestartDecision;
  /** 调度一次延时重启；传入新的 schedule 前会先 cancel 旧的。 */
  schedule(delayMs: number, run: () => void): void;
  /** 取消当前待执行的 scheduled restart；幂等。 */
  cancelScheduled(): void;
  /** 正常 stop 时调用：清零计数 + 取消挂起的 restart。 */
  reset(agentId: string): void;
}

export function createSelfHeal(cfg?: { maxRestarts?: number; backoffBaseMs?: number }): SelfHeal {
  const policy = createRestartPolicy({
    maxRestarts: cfg?.maxRestarts ?? 3,
    backoffBaseMs: cfg?.backoffBaseMs ?? 1000,
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancelScheduled = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return {
    policy,
    onCrash: (agentId) => policy.onCrash(agentId),
    schedule: (delayMs, run) => {
      cancelScheduled();
      timer = setTimeout(() => { timer = null; run(); }, delayMs);
    },
    cancelScheduled,
    reset: (agentId) => {
      cancelScheduled();
      policy.reset(agentId);
    },
  };
}
