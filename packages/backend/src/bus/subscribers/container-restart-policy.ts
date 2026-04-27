// M4 · container-restart-policy —— 崩溃重启计数 + 指数退避。
// 纯数据结构，不订阅 bus；由 container.subscriber 在 onExit 路径上调用。
// 公式：delay = backoffBaseMs * 2^(attempt-1)；attempt>maxRestarts → give_up。

export interface RestartPolicyConfig {
  maxRestarts: number;
  backoffBaseMs: number;
}

export interface RestartDecision {
  action: 'restart' | 'give_up';
  delayMs: number;
  attempt: number;
}

export interface RestartPolicy {
  onCrash(agentId: string): RestartDecision;
  reset(agentId: string): void;
  peek(agentId: string): number;
}

const DEFAULTS: RestartPolicyConfig = { maxRestarts: 3, backoffBaseMs: 1000 };

export function createRestartPolicy(cfg?: Partial<RestartPolicyConfig>): RestartPolicy {
  const { maxRestarts, backoffBaseMs } = { ...DEFAULTS, ...cfg };
  const counts = new Map<string, number>();
  return {
    onCrash(agentId): RestartDecision {
      const attempt = (counts.get(agentId) ?? 0) + 1;
      counts.set(agentId, attempt);
      if (attempt > maxRestarts) return { action: 'give_up', delayMs: 0, attempt };
      return { action: 'restart', delayMs: backoffBaseMs * 2 ** (attempt - 1), attempt };
    },
    reset(agentId): void {
      counts.delete(agentId);
    },
    peek(agentId): number {
      return counts.get(agentId) ?? 0;
    },
  };
}
