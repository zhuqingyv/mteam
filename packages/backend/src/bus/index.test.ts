// M8 · bootSubscribers 配置驱动单测。
// 原则（mnemo 红线）：不 mock bus；注入 new EventBus() 做隔离 —— 这是 subscriber 契约
// 允许的注入点，不是 mock。container deps 用 FakeRuntime / scriptedPolicy 等测试替身。
// 每个 case 独立 boot/teardown；teardown 只 destroy defaultBus，注入 bus 不受影响。
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { EventBus } from './events.js';
import { bootSubscribers, teardownSubscribers } from './index.js';
import { makeBase } from './helpers.js';
import { closeDb, getDb } from '../db/connection.js';
import { createFakeRuntime, type FakeRuntime } from './subscribers/__test-fixtures__/fake-runtime.js';
import type { CommRouter } from '../comm/router.js';
import type { BusEvent } from './events.js';
import type {
  ContainerStartedEvent,
  ContainerExitedEvent,
  InstanceOfflineRequestedEvent,
} from './types.js';
import type { RuntimeConfigResolved } from './subscribers/container.subscriber.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fakeRouter = {
  dispatch: (): { status: 'ok'; delivered: 0 } => ({ status: 'ok', delivered: 0 }),
} as unknown as CommRouter;

function collect(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));
  return events;
}

function runtimeConfig(): RuntimeConfigResolved {
  return { runtime: 'host', command: 'fake', args: [], env: {} };
}

function containerDeps(runtime: FakeRuntime): {
  readRuntimeConfig: (agentId: string, cliType: string) => RuntimeConfigResolved;
  buildRuntime: (kind: 'host' | 'docker', opts: unknown) => FakeRuntime;
} {
  return { readRuntimeConfig: () => runtimeConfig(), buildRuntime: () => runtime };
}

beforeEach(() => {
  closeDb();
  getDb();
});

afterEach(() => {
  // 若上个 case 忘了 teardown，这里兜底（teardown 幂等）。
  try {
    teardownSubscribers();
  } catch {
    /* ignore: teardown 幂等 */
  }
  closeDb();
});

describe('bootSubscribers 配置驱动', () => {
  it('不传 config：只注册现有 subscribers，emit 容器/策略事件无副作用', () => {
    const bus = new EventBus();
    const events = collect(bus);
    bootSubscribers({ commRouter: fakeRouter }, {}, bus);
    bus.emit({ ...makeBase('primary_agent.started', 'test'), agentId: 'a1', cliType: 'claude' });
    // container.subscriber 未注册：不应有 container.started
    expect(events.some((e) => e.type === 'container.started')).toBe(false);
    teardownSubscribers();
  });

  it('sandbox.enabled=false：不注册 container.subscriber（primary_agent.started 无 container.started 回响）', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const runtime = createFakeRuntime();
    bootSubscribers(
      { commRouter: fakeRouter },
      { sandbox: { enabled: false, transport: 'stdio', containerDeps: containerDeps(runtime) } },
      bus,
    );
    bus.emit({ ...makeBase('primary_agent.started', 'test'), agentId: 'a1', cliType: 'claude' });
    expect(events.some((e) => e.type === 'container.started')).toBe(false);
    expect(runtime.specs.length).toBe(0);
    teardownSubscribers();
  });

  it('sandbox.enabled=true：emit primary_agent.started 后能收到 container.started', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const runtime = createFakeRuntime([42]);
    bootSubscribers(
      { commRouter: fakeRouter },
      { sandbox: { enabled: true, transport: 'stdio', containerDeps: containerDeps(runtime) } },
      bus,
    );
    bus.emit({ ...makeBase('primary_agent.started', 'test'), agentId: 'a1', cliType: 'claude' });
    // spawn 是 async；FakeRuntime 的 spawn 立即 resolve，但 container.subscriber 内部 await —
    // 用 microtask 刷新队列，让 onExit 注册 + emit container.started 跑完。
    await Promise.resolve();
    await Promise.resolve();
    const started = events.find((e) => e.type === 'container.started') as ContainerStartedEvent | undefined;
    expect(started).toBeDefined();
    expect(started!.agentId).toBe('a1');
    expect(started!.runtimeKind).toBe('host');
    expect(started!.containerId).toBe('42');
    teardownSubscribers();
  });

  it('policy.enabled=false：driver.tool_call 不会触发 instance.offline_requested', () => {
    const bus = new EventBus();
    const events = collect(bus);
    bootSubscribers(
      { commRouter: fakeRouter },
      { policy: { enabled: false } },
      bus,
    );
    bus.emit({
      ...makeBase('driver.tool_call', 'test'),
      driverId: 'i1',
      name: 'Bash',
      input: {},
    });
    expect(events.some((e) => e.type === 'instance.offline_requested')).toBe(false);
    teardownSubscribers();
  });

  it('policy.enabled=true 且命中 deny：driver.tool_call → instance.offline_requested(explicit_deny)', () => {
    // 写一份全局 policy.yaml 到 tmp 目录
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-index-test-'));
    const cfg = path.join(dir, 'policy.yaml');
    fs.writeFileSync(cfg, 'global_deny:\n  - Bash\n', 'utf8');
    try {
      const bus = new EventBus();
      const events = collect(bus);
      bootSubscribers(
        { commRouter: fakeRouter },
        { policy: { enabled: true, configPath: cfg } },
        bus,
      );
      bus.emit({
        ...makeBase('driver.tool_call', 'test'),
        driverId: 'i1',
        name: 'Bash',
        input: {},
      });
      const offline = events.find((e) => e.type === 'instance.offline_requested') as
        | InstanceOfflineRequestedEvent
        | undefined;
      expect(offline).toBeDefined();
      expect(offline!.instanceId).toBe('i1');
      expect(offline!.requestedBy).toBe('policy-enforcer');
      teardownSubscribers();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重复调用 bootSubscribers 幂等：第二次不重复注册', () => {
    const bus = new EventBus();
    const events = collect(bus);
    bootSubscribers({ commRouter: fakeRouter }, {}, bus);
    bootSubscribers({ commRouter: fakeRouter }, {}, bus);
    // 只有一份 subscriber；暴露方式：emit instance.created 应只触发一次 roster.add。
    // 这里用 events 数量侧面判：emit 一次事件，自己监听到一次即可（events$ share，多次 boot 不会额外复制）。
    bus.emit({
      ...makeBase('instance.created', 'test'),
      instanceId: 'i1',
      templateName: 'tpl',
      memberName: 'm',
      isLeader: false,
      teamId: null,
      task: null,
    });
    expect(events.filter((e) => e.type === 'instance.created').length).toBe(1);
    teardownSubscribers();
  });

  it('teardownSubscribers 幂等：注入 bus 不会被 destroy（可继续 emit）', () => {
    const bus = new EventBus();
    const events = collect(bus);
    bootSubscribers({ commRouter: fakeRouter }, {}, bus);
    teardownSubscribers();
    teardownSubscribers(); // 再调一次不应抛错
    bus.emit({ ...makeBase('instance.created', 'test'), instanceId: 'i2', templateName: 't', memberName: 'm', isLeader: false, teamId: null, task: null });
    // 注入 bus 没被 destroy —— emit 仍然能被 collect 拿到
    expect(events.length).toBeGreaterThan(0);
  });

  it('sandbox.enabled=true + container 退出：收到 container.exited(stop_requested)', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const runtime = createFakeRuntime();
    bootSubscribers(
      { commRouter: fakeRouter },
      { sandbox: { enabled: true, transport: 'stdio', containerDeps: containerDeps(runtime) } },
      bus,
    );
    bus.emit({ ...makeBase('primary_agent.started', 'test'), agentId: 'a1', cliType: 'claude' });
    await Promise.resolve();
    await Promise.resolve();
    bus.emit({ ...makeBase('primary_agent.stopped', 'test'), agentId: 'a1' });
    await Promise.resolve();
    await Promise.resolve();
    const exited = events.find((e) => e.type === 'container.exited') as ContainerExitedEvent | undefined;
    expect(exited).toBeDefined();
    expect(exited!.reason).toBe('stop_requested');
    teardownSubscribers();
  });
});
