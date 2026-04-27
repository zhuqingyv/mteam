// container.subscriber 单测 —— 真 EventBus + 真 registry + FakeRuntime 注入。
// 不 mock bus/db；时间用极小 delayMs（0~10ms）让真 setTimeout 跑完。
import { describe, it, expect } from 'bun:test';
import type { Subscription } from 'rxjs';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { createContainerRegistry } from './container-registry.js';
import {
  subscribeContainer,
  type RestartDecision,
  type RestartPolicy,
  type RuntimeConfigResolved,
} from './container.subscriber.js';
import { createFakeRuntime, type FakeRuntime } from './__test-fixtures__/fake-runtime.js';
import type { BusEvent } from '../events.js';
import type {
  ContainerStartedEvent,
  ContainerExitedEvent,
  ContainerCrashedEvent,
} from '../types.js';

// 可编排的 RestartPolicy：按入参 agentId 依次回放一串 RestartDecision。
function scriptedPolicy(script: RestartDecision[]): RestartPolicy & { calls: string[]; resets: string[] } {
  const calls: string[] = [];
  const resets: string[] = [];
  let idx = 0;
  return {
    onCrash(agentId): RestartDecision {
      calls.push(agentId);
      return script[idx++] ?? { action: 'give_up', delayMs: 0, attempt: idx };
    },
    reset(agentId): void { resets.push(agentId); idx = 0; },
    peek(): number { return idx; },
    calls,
    resets,
  };
}

interface Ctx {
  bus: EventBus;
  runtime: FakeRuntime;
  events: BusEvent[];
  subscription: Subscription;
  emitStart: (agentId: string, cliType?: string) => void;
  emitStop: (agentId: string) => void;
}

function setup(
  opts: {
    script?: RestartDecision[];
    cfg?: Partial<RuntimeConfigResolved>;
    enabled?: boolean;
  } = {},
): Ctx & { policy: ReturnType<typeof scriptedPolicy>; registry: ReturnType<typeof createContainerRegistry> } {
  const bus = new EventBus();
  const runtime = createFakeRuntime();
  const registry = createContainerRegistry();
  const policy = scriptedPolicy(opts.script ?? []);
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));

  const base: RuntimeConfigResolved = {
    runtime: 'host', command: 'claude', args: ['--help'], env: { A: '1' }, cwd: '/tmp',
    ...(opts.cfg ?? {}),
  };
  const subscription = subscribeContainer(
    { enabled: opts.enabled ?? true },
    {
      registry, restartPolicy: policy,
      readRuntimeConfig: (): RuntimeConfigResolved => base,
      buildRuntime: (): typeof runtime => runtime,
    },
    bus,
  );

  return {
    bus, runtime, events, registry, policy, subscription,
    emitStart: (agentId, cliType = 'claude'): void => {
      bus.emit({ ...makeBase('primary_agent.started', 'test'), agentId, cliType });
    },
    emitStop: (agentId): void => {
      bus.emit({ ...makeBase('primary_agent.stopped', 'test'), agentId });
    },
  };
}

async function tick(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

describe('container.subscriber', () => {
  it('host runtime: primary_agent.started → spawn + register + container.started', async () => {
    const ctx = setup();
    ctx.emitStart('a1');
    await tick(5);

    expect(ctx.runtime.specs).toHaveLength(1);
    expect(ctx.runtime.specs[0]!.runtime).toBe('host');
    expect(ctx.registry.get('a1')).not.toBeNull();

    const started = ctx.events.find((e) => e.type === 'container.started') as ContainerStartedEvent | undefined;
    expect(started).toBeDefined();
    expect(started!.agentId).toBe('a1');
    expect(started!.runtimeKind).toBe('host');
    expect(started!.containerId).toBe(String(ctx.runtime.handles[0]!.pid));
  });

  it('docker runtime 路径：LaunchSpec.runtime = docker', async () => {
    const ctx = setup({ cfg: { runtime: 'docker' } });
    ctx.emitStart('a2');
    await tick(5);
    expect(ctx.runtime.specs[0]!.runtime).toBe('docker');
    const started = ctx.events.find((e) => e.type === 'container.started') as ContainerStartedEvent;
    expect(started.runtimeKind).toBe('docker');
  });

  it('重复 primary_agent.started 同 agentId → 跳过，不起第二进程', async () => {
    const ctx = setup();
    ctx.emitStart('a1'); await tick(5);
    ctx.emitStart('a1'); await tick(5);
    expect(ctx.runtime.specs).toHaveLength(1);
  });

  it('非零退出 → container.crashed + 指数退避后 re-emit primary_agent.started', async () => {
    const ctx = setup({
      script: [{ action: 'restart', delayMs: 10, attempt: 1 }],
    });
    ctx.emitStart('a1');
    await tick(5);
    ctx.runtime.handles[0]!.emitExit(1, null);
    await tick(2);
    const crashed = ctx.events.find((e) => e.type === 'container.crashed') as ContainerCrashedEvent | undefined;
    expect(crashed).toBeDefined();
    expect(crashed!.exitCode).toBe(1);
    expect(crashed!.cliType).toBe('claude');
    expect(ctx.registry.get('a1')).toBeNull(); // 崩溃时先 remove
    await tick(15);
    // 重启 timer 触发后，subscriber 会 re-emit primary_agent.started → 再 spawn 一次
    expect(ctx.runtime.specs).toHaveLength(2);
    expect(ctx.registry.get('a1')).not.toBeNull();
  });

  it('超过 maxRestarts → container.exited(reason=max_restart_exceeded)', async () => {
    const ctx = setup({
      script: [{ action: 'give_up', delayMs: 0, attempt: 4 }],
    });
    ctx.emitStart('a1');
    await tick(5);
    ctx.runtime.handles[0]!.emitExit(1, null);
    await tick(5);
    const exited = ctx.events.find((e) => e.type === 'container.exited') as ContainerExitedEvent;
    expect(exited).toBeDefined();
    expect(exited.reason).toBe('max_restart_exceeded');
    expect(exited.exitCode).toBe(1);
  });

  it('primary_agent.stopped → handle.kill + registry 清理 + container.exited(stop_requested)', async () => {
    const ctx = setup();
    ctx.emitStart('a1'); await tick(5);
    const h = ctx.runtime.handles[0]!;
    ctx.emitStop('a1');
    await tick(5);
    expect(h.killed).toBe(true);
    expect(ctx.registry.get('a1')).toBeNull();
    const exited = ctx.events.find((e) => e.type === 'container.exited') as ContainerExitedEvent;
    expect(exited.reason).toBe('stop_requested');
    expect(exited.exitCode).toBeNull();
    // stopped 路径 onExit 回调应被 userStopped 门禁挡住 → 不 emit crashed
    const crashed = ctx.events.find((e) => e.type === 'container.crashed');
    expect(crashed).toBeUndefined();
  });

  it('重启 setTimeout 期间收到 stopped → timer 不触发第二次 spawn', async () => {
    const ctx = setup({
      script: [{ action: 'restart', delayMs: 30, attempt: 1 }],
    });
    ctx.emitStart('a1'); await tick(5);
    ctx.runtime.handles[0]!.emitExit(1, null);
    await tick(5);
    expect(ctx.runtime.specs).toHaveLength(1); // 等待重启中
    ctx.emitStop('a1');
    await tick(40); // 穿过原本的重启 delay
    expect(ctx.runtime.specs).toHaveLength(1); // 没再 spawn
  });

  it('正常退出 (code=0) → container.exited(normal_exit) + restartPolicy.reset', async () => {
    const ctx = setup();
    ctx.emitStart('a1'); await tick(5);
    ctx.runtime.handles[0]!.emitExit(0, null);
    await tick(5);
    const exited = ctx.events.find((e) => e.type === 'container.exited') as ContainerExitedEvent;
    expect(exited.reason).toBe('normal_exit');
    expect(exited.exitCode).toBe(0);
    expect(ctx.policy.resets).toContain('a1');
    expect(ctx.registry.get('a1')).toBeNull();
  });

  it('不同 agentId 的生命周期互相隔离', async () => {
    const ctx = setup({
      script: [{ action: 'restart', delayMs: 100, attempt: 1 }],
    });
    ctx.emitStart('a1'); ctx.emitStart('a2');
    await tick(5);
    expect(ctx.registry.size()).toBe(2);
    ctx.emitStop('a2');
    await tick(5);
    expect(ctx.registry.get('a1')).not.toBeNull();
    expect(ctx.registry.get('a2')).toBeNull();
  });

  it('spawn 抛错 → 不注册 + 不 emit container.started + 不 crash 下游', async () => {
    const ctx = setup();
    ctx.runtime.failNextSpawn(new Error('boom'));
    ctx.emitStart('a1');
    await tick(5);
    expect(ctx.registry.get('a1')).toBeNull();
    const started = ctx.events.find((e) => e.type === 'container.started');
    expect(started).toBeUndefined();
  });

  it('teardown(unsubscribe) → 所有 registry 条目的 handle.kill 被调 + registry 清空', async () => {
    const ctx = setup();
    ctx.emitStart('a1');
    ctx.emitStart('a2');
    await tick(5);
    const h1 = ctx.runtime.handles[0]!;
    const h2 = ctx.runtime.handles[1]!;
    expect(ctx.registry.size()).toBe(2);
    ctx.subscription.unsubscribe();
    expect(h1.killed).toBe(true);
    expect(h2.killed).toBe(true);
    expect(ctx.registry.size()).toBe(0);
  });

  it('teardown 时 handle.kill 抛错不会冒泡（Promise.allSettled 吞错）', async () => {
    const ctx = setup();
    ctx.emitStart('a1');
    await tick(5);
    const h = ctx.runtime.handles[0]!;
    h.kill = async (): Promise<void> => { throw new Error('boom'); };
    expect(() => ctx.subscription.unsubscribe()).not.toThrow();
    expect(ctx.registry.size()).toBe(0);
  });

  it('teardown 清空重启定时器（既有行为保留）', async () => {
    const ctx = setup({ script: [{ action: 'restart', delayMs: 50, attempt: 1 }] });
    ctx.emitStart('a1');
    await tick(5);
    ctx.runtime.handles[0]!.emitExit(1, null);
    await tick(5);
    ctx.subscription.unsubscribe();
    await tick(80);
    // 未 re-emit primary_agent.started（timer 已 clear）
    expect(ctx.runtime.specs).toHaveLength(1);
  });

  it('enabled=false → 不订阅事件，emit 完全静默', async () => {
    const ctx = setup({ enabled: false });
    ctx.emitStart('a1');
    await tick(5);
    expect(ctx.runtime.specs).toHaveLength(0);
    expect(ctx.registry.size()).toBe(0);
    const started = ctx.events.find((e) => e.type === 'container.started');
    expect(started).toBeUndefined();
  });
});
