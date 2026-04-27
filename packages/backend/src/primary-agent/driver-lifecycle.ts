// 主 Agent 的 driver 事件订阅 + 失败恢复。
// 从 primary-agent.ts 拆出来：bus 事件监听、agentState 状态机、driver.error/stopped 清理。
// PrimaryAgent 保留 state ownership，这里只提供 pure function 收敛逻辑。
import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import type { AgentDriver } from '../agent-driver/driver.js';
import type { DriverRegistry } from '../agent-driver/registry.js';
import { setStatus } from './repo.js';
import type { AgentState } from './types.js';

export interface DriverLifecycleHost {
  readonly eventBus: EventBus;
  readonly driverRegistry: DriverRegistry;
  getDriver(): AgentDriver | null;
  clearDriver(): void;
  getAgentState(): AgentState;
  setAgentState(state: AgentState): void;
  unsubscribeDriver(): void;
}

// 订阅 bus 驱动 agentState + 驱动失败/停止恢复。返回 Subscription 供上层保存。
export function subscribeDriverEvents(host: DriverLifecycleHost, agentId: string): Subscription {
  return defaultBus.events$.subscribe((ev) => {
    if (ev.type === 'driver.error') {
      if (ev.driverId !== agentId) return;
      process.stderr.write(`[primary-agent] driver error: ${ev.message}\n`);
      host.setAgentState('idle');
      void handleDriverFailure(host, agentId);
    } else if (ev.type === 'driver.stopped') {
      if (ev.driverId !== agentId) return;
      host.setAgentState('idle');
      handleDriverStopped(host, agentId);
    }
    // agentState 状态机：prompt 收到→thinking, 有内容→responding, 完成→idle
    else if (ev.type === 'turn.started') {
      host.setAgentState('thinking');
    } else if (ev.type === 'turn.block_updated') {
      if (host.getAgentState() === 'thinking') host.setAgentState('responding');
    } else if (ev.type === 'turn.completed' || ev.type === 'turn.error') {
      host.setAgentState('idle');
    }
  });
}

async function handleDriverFailure(host: DriverLifecycleHost, agentId: string): Promise<void> {
  const d = host.getDriver();
  if (!d) return;
  host.unsubscribeDriver();
  host.clearDriver();
  try { await d.stop(); } catch { /* ignore */ }
  emitStopped(host, agentId);
}

function handleDriverStopped(host: DriverLifecycleHost, agentId: string): void {
  if (!host.getDriver()) return;
  // driver 自己发的 stopped 事件：子进程挂了，同步 DB 状态。
  host.unsubscribeDriver();
  host.clearDriver();
  emitStopped(host, agentId);
}

function emitStopped(host: DriverLifecycleHost, agentId: string): void {
  host.driverRegistry.unregister(agentId);
  setStatus(agentId, 'STOPPED');
  host.eventBus.emit({
    ...makeBase('primary_agent.stopped', 'primary-agent'),
    agentId,
  });
}
