// Container subscriber —— 主 agent 容器生命周期编排（Stage 5 胶水）。
// 时序 / 竞态 / 错误传播详见同目录 CONTAINER-README.md。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import type { LaunchSpec, ProcessRuntime, RuntimeHandle } from '../../process-runtime/types.js';
import type { ContainerRegistry } from './container-registry.js';

export interface RestartDecision { action: 'restart' | 'give_up'; delayMs: number; attempt: number; }
export interface RestartPolicy {
  onCrash(agentId: string): RestartDecision;
  reset(agentId: string): void;
  peek(agentId: string): number;
}
export interface RuntimeConfigResolved {
  runtime: 'host' | 'docker';
  command: string; args: string[]; env: Record<string, string>; cwd?: string;
  dockerOptions?: Record<string, unknown>; hostOptions?: Record<string, unknown>;
}
export interface ContainerSubscriberDeps {
  registry: ContainerRegistry;
  restartPolicy: RestartPolicy;
  readRuntimeConfig: (agentId: string, cliType: string) => RuntimeConfigResolved;
  buildRuntime: (kind: 'host' | 'docker', opts: unknown) => ProcessRuntime;
}
export interface ContainerSubscriberConfig { enabled: boolean; transport?: 'http' | 'stdio'; }

type ExitReason = 'stop_requested' | 'max_restart_exceeded' | 'normal_exit';
interface Lifecycle { userStopped: boolean; restartTimer: ReturnType<typeof setTimeout> | null; cliType: string; }

export function subscribeContainer(
  config: ContainerSubscriberConfig,
  deps: ContainerSubscriberDeps,
  eventBus: EventBus = defaultBus,
): Subscription {
  const master = new Subscription();
  if (!config.enabled) return master;
  const { registry, restartPolicy, readRuntimeConfig, buildRuntime } = deps;
  const lifecycles = new Map<string, Lifecycle>();
  const emit = eventBus.emit.bind(eventBus);
  const emitExited = (agentId: string, reason: ExitReason, exitCode: number | null): void =>
    emit({ ...makeBase('container.exited', 'container.subscriber'), agentId, reason, exitCode });

  const start = async (agentId: string, cliType: string): Promise<void> => {
    if (registry.get(agentId)) return; // C1: duplicate started → skip
    const cfg = readRuntimeConfig(agentId, cliType);
    const runtime = buildRuntime(cfg.runtime, cfg.runtime === 'docker' ? cfg.dockerOptions : cfg.hostOptions);
    const spec: LaunchSpec = {
      runtime: cfg.runtime, command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd ?? process.cwd(),
    };
    let handle: RuntimeHandle;
    try { handle = await runtime.spawn(spec); }
    catch (err) {
      process.stderr.write(`[container.subscriber] spawn failed ${agentId}: ${(err as Error).message}\n`);
      return;
    }
    lifecycles.set(agentId, { userStopped: false, restartTimer: null, cliType });
    registry.register(agentId, { handle, runtime, runtimeKind: cfg.runtime });
    handle.onExit((code, signal) => onExit(agentId, code, signal));
    emit({ ...makeBase('container.started', 'container.subscriber'), agentId, runtimeKind: cfg.runtime, containerId: String(handle.pid) });
  };

  const onExit = (agentId: string, code: number | null, _signal: string | null): void => {
    const life = lifecycles.get(agentId);
    registry.remove(agentId);
    if (!life || life.userStopped) return; // C2: stopped 路径自己 emit exited
    if (code === 0) { restartPolicy.reset(agentId); lifecycles.delete(agentId); emitExited(agentId, 'normal_exit', 0); return; }
    emit({ ...makeBase('container.crashed', 'container.subscriber'), agentId, cliType: life.cliType, exitCode: code ?? -1, signal: null });
    const decision = restartPolicy.onCrash(agentId);
    if (decision.action === 'give_up') { lifecycles.delete(agentId); emitExited(agentId, 'max_restart_exceeded', code); return; }
    life.restartTimer = setTimeout(() => {
      life.restartTimer = null;
      emit({ ...makeBase('primary_agent.started', 'container.subscriber'), agentId, cliType: life.cliType });
    }, decision.delayMs);
  };

  const stop = async (agentId: string): Promise<void> => {
    const life = lifecycles.get(agentId);
    const entry = registry.get(agentId);
    if (life) { life.userStopped = true; if (life.restartTimer) { clearTimeout(life.restartTimer); life.restartTimer = null; } }
    lifecycles.delete(agentId);
    registry.remove(agentId);
    restartPolicy.reset(agentId);
    if (entry) {
      try { await entry.handle.kill(); }
      catch (err) { process.stderr.write(`[container.subscriber] kill failed ${agentId}: ${(err as Error).message}\n`); }
    }
    emitExited(agentId, 'stop_requested', null);
  };

  master.add(eventBus.on('primary_agent.started').subscribe((e) => { void start(e.agentId, e.cliType); }));
  master.add(eventBus.on('primary_agent.stopped').subscribe((e) => { void stop(e.agentId); }));
  master.add(() => {
    for (const [, life] of lifecycles) if (life.restartTimer) clearTimeout(life.restartTimer);
    lifecycles.clear();
    const entries = registry.list();
    registry.clear();
    void Promise.allSettled(entries.map((e) => e.entry.handle.kill()));
  });
  return master;
}
