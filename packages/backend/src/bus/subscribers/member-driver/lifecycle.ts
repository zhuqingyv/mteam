// member-driver / lifecycle —— 成员 AgentDriver 生命周期胶水。
//
// 订阅：
//   instance.created            → 起 driver（skip leader / 缺模板 / 缺 instance）
//   instance.deleted            → 停 driver + 解注册
//   instance.offline_requested  → 停 driver + 解注册（PENDING_OFFLINE 后成员行还在）
//
// 产出：attachDriverToBus 让 AgentDriver 的 events$ 翻译成 bus 的
//       driver.started / driver.stopped / driver.error / driver.text ...，driverId === instanceId。
//       兄弟模块 W2-1b replay（lifecycle 直接 await 调用）/ W2-1c pid-writeback
//       （订阅 driver.started）各自接在这条链上。
//
// 时序、竞态与错误传播详见同目录 README.md。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../../events.js';
import { RoleTemplate } from '../../../domain/role-template.js';
import { RoleInstance } from '../../../domain/role-instance.js';
import { mcpManager } from '../../../mcp-store/mcp-manager.js';
import { buildMemberDriverConfig } from '../../../member-agent/driver-config.js';
import { AgentDriver, createAdapter } from '../../../agent-driver/driver.js';
import { attachDriverToBus } from '../../../agent-driver/bus-bridge.js';
import { driverRegistry as defaultRegistry, type DriverRegistry } from '../../../agent-driver/registry.js';
import { HostRuntime } from '../../../process-runtime/host-runtime.js';
import { processManager } from '../../../process-manager/index.js';
import type { ProcessRuntime, RuntimeHandle, LaunchSpec } from '../../../process-runtime/types.js';
import { defaultCommSock } from '../../../primary-agent/driver-config.js';
import { replayForDriver } from './replay.js';
import type { DriverConfig } from '../../../agent-driver/types.js';

export interface SubscribeMemberDriverLifecycleDeps {
  eventBus?: EventBus;
  registry?: DriverRegistry;
  runtime?: ProcessRuntime;
  hubUrl?: string;
  commSock?: string;
}

// 测试用探针：让单测能观察 queues / entries 的尺寸以验证 GC 行为。
// 生产代码不用读这俩字段，但留着也无副作用。
export interface MemberDriverLifecycleSubscription extends Subscription {
  readonly __queueIds: () => string[];
  readonly __entryIds: () => string[];
}

interface Entry { driver: AgentDriver; handle: RuntimeHandle; busSub: Subscription; }

export function subscribeMemberDriverLifecycle(
  deps: SubscribeMemberDriverLifecycleDeps = {},
): MemberDriverLifecycleSubscription {
  const eventBus = deps.eventBus ?? defaultBus;
  const registry = deps.registry ?? defaultRegistry;
  const runtime = deps.runtime ?? new HostRuntime();
  const hubUrl = deps.hubUrl ?? `http://localhost:${process.env.V2_PORT ?? '58590'}`;
  const commSock = deps.commSock ?? defaultCommSock();

  const entries = new Map<string, Entry>();
  // per-instance 串行队列：activate / deactivate 并发按入队顺序串行执行，杜绝重入。
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tracked = next.catch(() => undefined);
    queues.set(id, tracked);
    // 任务落地后若尾部仍是自己，就把 id 清掉，防止 Map 无限增长。
    // 若期间又有新任务入队，tail 已被替换成 newer，这里 get !== tracked 就不会误删。
    void tracked.then(() => { if (queues.get(id) === tracked) queues.delete(id); });
    return next;
  };

  const startMember = async (instanceId: string): Promise<void> => {
    if (entries.has(instanceId)) await stopMember(instanceId);  // C3: 重复 created → 先 teardown
    const instance = RoleInstance.findById(instanceId);
    if (!instance || instance.isLeader) return;
    const template = RoleTemplate.findByName(instance.templateName);
    if (!template) {
      process.stderr.write(`[member-driver/lifecycle] template '${instance.templateName}' not found for ${instanceId}\n`);
      return;
    }

    const resolvedMcps = mcpManager.resolve(template.availableMcps, {
      instanceId, hubUrl, commSock, isLeader: false,
    });
    const { config, skipped } = buildMemberDriverConfig({
      instance: {
        id: instance.id, memberName: instance.memberName,
        leaderName: instance.leaderName, task: instance.task,
        runtimeKind: 'host',
      },
      template: { persona: template.persona, role: { cliType: 'claude' } },
      resolvedMcps,
    });
    for (const name of skipped) process.stderr.write(`[member-driver/lifecycle] mcp '${name}' unavailable for ${instanceId}\n`);

    const adapter = createAdapter(config);
    const spec = mergeHostEnv(adapter.prepareLaunch(config), config);
    let handle: RuntimeHandle;
    try {
      handle = await runtime.spawn(spec);
    } catch (err) {
      adapter.cleanup(); // spawn 失败：adapter 自己兜底删临时文件（W2-8）
      throw err;
    }
    // spawn 成功：临时文件移交 ProcessManager，退出时统一 unlink
    if (typeof handle.pid === 'number') {
      processManager.attachTempFiles(handle.pid, adapter.listTempFiles());
    }
    const driver = new AgentDriver(instanceId, config, handle, adapter);
    const busSub = attachDriverToBus(instanceId, driver.events$, eventBus);
    entries.set(instanceId, { driver, handle, busSub });  // C1: 先写 map 再 start，并发 stop 能兜底 teardown

    try {
      await driver.start();
    } catch (err) {
      process.stderr.write(`[member-driver/lifecycle] driver.start failed for ${instanceId}: ${(err as Error).message}\n`);
      entries.delete(instanceId);
      busSub.unsubscribe();
      try { await handle.kill(); } catch { /* ignore */ }
      return;
    }
    registry.register(instanceId, driver);

    try {
      await replayForDriver(instanceId, driver);
    } catch (err) {
      process.stderr.write(`[member-driver/lifecycle] replay failed for ${instanceId}: ${(err as Error).message}\n`);
    }
  };

  const stopMember = async (instanceId: string): Promise<void> => {
    const entry = entries.get(instanceId);
    if (!entry) return;
    entries.delete(instanceId);
    registry.unregister(instanceId);
    try { await entry.driver.stop(); } catch { /* ignore */ }
    try { await entry.handle.kill(); } catch { /* ignore */ }
    entry.busSub.unsubscribe();
  };

  const masterSub = new Subscription();
  masterSub.add(eventBus.on('instance.created').subscribe((e) => {
    void enqueue(e.instanceId, () => startMember(e.instanceId)).catch((err) =>
      process.stderr.write(`[member-driver/lifecycle] unexpected start error ${e.instanceId}: ${(err as Error).message}\n`));
  }));
  const onStop = (instanceId: string): void => {
    void enqueue(instanceId, () => stopMember(instanceId)).catch((err) =>
      process.stderr.write(`[member-driver/lifecycle] unexpected stop error ${instanceId}: ${(err as Error).message}\n`));
  };
  masterSub.add(eventBus.on('instance.deleted').subscribe((e) => onStop(e.instanceId)));
  masterSub.add(eventBus.on('instance.offline_requested').subscribe((e) => onStop(e.instanceId)));

  masterSub.add(() => {
    // 订阅撤销：把所有进行中的 driver 一并 teardown，避免 test 漏进程。
    const ids = Array.from(entries.keys());
    for (const id of ids) void stopMember(id);
  });
  const probe = masterSub as MemberDriverLifecycleSubscription;
  Object.defineProperty(probe, '__queueIds', { value: () => Array.from(queues.keys()) });
  Object.defineProperty(probe, '__entryIds', { value: () => Array.from(entries.keys()) });
  return probe;
}

// host 模式下 adapter 不感知父进程 env；胶水层合并 process.env 保证 PATH 等基础变量在位。
function mergeHostEnv(spec: LaunchSpec, config: DriverConfig): LaunchSpec {
  if (spec.runtime !== 'host') return spec;
  const parent: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') parent[k] = v;
  return { ...spec, env: { ...parent, ...(config.env ?? {}), ...spec.env } };
}
