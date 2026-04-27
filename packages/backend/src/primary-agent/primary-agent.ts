// 主 Agent 对前端只暴露 WS 接口（推送 + 主动请求），不新增 HTTP 端点。
// 配置/启停/快照/历史全部走 WS op，HTTP 层只保留 /ws/events upgrade 本身。
import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import { cliManager } from '../cli-scanner/manager.js';
import { AgentDriver } from '../agent-driver/driver.js';
import { attachDriverToBus } from '../agent-driver/bus-bridge.js';
import { driverRegistry as defaultDriverRegistry, type DriverRegistry } from '../agent-driver/registry.js';
import { HostRuntime } from '../process-runtime/host-runtime.js';
import type { ProcessRuntime } from '../process-runtime/types.js';
import { readRow, upsertConfig, setStatus } from './repo.js';
import { spawnForRow } from './runtime-select.js';
import { prepareStart, waitForCliScan, type CliWaitHost } from './bootstrap.js';
import { subscribeDriverEvents, type DriverLifecycleHost } from './driver-lifecycle.js';
import { buildHistoryPromptBlock, DEFAULT_HISTORY_LIMIT } from './history-injector.js';
import { listRecentByDriver } from '../turn-history/repo.js';
import type { PrimaryAgentConfig, PrimaryAgentRow, AgentState } from './types.js';

export class PrimaryAgent implements DriverLifecycleHost, CliWaitHost {
  private driver: AgentDriver | null = null;
  private driverSub: Subscription | null = null;
  private driverBusSub: Subscription | null = null;
  private cliSub: Subscription | null = null;
  private _agentState: AgentState = 'idle';

  get agentState(): AgentState { return this._agentState; }
  getAgentState(): AgentState { return this._agentState; }
  getDriver(): AgentDriver | null { return this.driver; }
  clearDriver(): void { this.driver = null; }
  getCliSub(): Subscription | null { return this.cliSub; }
  setCliSub(sub: Subscription | null): void { this.cliSub = sub; }
  reboot(): void { this.boot(); }

  setAgentState(state: AgentState): void {
    if (this._agentState === state) return;
    this._agentState = state;
    const row = readRow();
    if (row) {
      this.eventBus.emit({
        ...makeBase('primary_agent.state_changed', 'primary-agent'),
        agentId: row.id,
        agentState: state,
      });
    }
  }

  // 显式注入 runtime（测试 FakeRuntime）时不动它；未注入时 start() 按 row.sandbox 动态切换。
  private runtime: ProcessRuntime;
  private readonly hasInjectedRuntime: boolean;
  constructor(
    readonly eventBus: EventBus = defaultBus,
    runtime?: ProcessRuntime,
    readonly driverRegistry: DriverRegistry = defaultDriverRegistry,
  ) {
    this.hasInjectedRuntime = runtime !== undefined;
    this.runtime = runtime ?? new HostRuntime();
  }

  boot(): void {
    if (this.driver) return; // 幂等
    const res = prepareStart();
    if (res.kind === 'wait-cli') {
      waitForCliScan(this);
      return;
    }
    this.start().catch((err) => {
      process.stderr.write(
        `[primary-agent] auto-start failed: ${(err as Error).message}\n`,
      );
    });
  }

  async teardown(): Promise<void> {
    if (this.cliSub) {
      this.cliSub.unsubscribe();
      this.cliSub = null;
    }
    if (this.isRunning()) await this.stop();
  }

  async configure(config: PrimaryAgentConfig): Promise<PrimaryAgentRow> {
    const before = readRow();
    const next = upsertConfig(config);
    this.eventBus.emit({
      ...makeBase('primary_agent.configured', 'primary-agent'),
      agentId: next.id,
      cliType: next.cliType,
      name: next.name,
      row: next,
    });

    // 切换 cliType 时：跑着就先停再按新配置起。
    const cliChanged = !!before && before.cliType !== next.cliType;
    if (cliChanged && this.driver) {
      await this.stop();
      await this.start();
    }
    return next;
  }

  getConfig(): PrimaryAgentRow | null {
    return readRow();
  }

  async start(): Promise<PrimaryAgentRow> {
    const row = readRow();
    if (!row) throw new Error('primary agent not configured');
    if (this.driver) return row;
    if (!cliManager.isAvailable(row.cliType)) {
      throw new Error(`cli '${row.cliType}' is not available`);
    }

    let historyPromptBlock = '';
    try {
      const { items } = listRecentByDriver(row.id, { limit: DEFAULT_HISTORY_LIMIT });
      historyPromptBlock = buildHistoryPromptBlock(items);
    } catch (err) {
      process.stderr.write(
        `[primary-agent] history inject failed (continuing): ${(err as Error).message}\n`,
      );
    }

    // runtime_select 封装：优先注入实例；未注入时按 row.sandbox 选 Host/Docker，带 docker→host 降级。
    const res = await spawnForRow({
      row,
      historyPromptBlock,
      injected: this.hasInjectedRuntime ? this.runtime : null,
    });
    for (const name of res.skipped) {
      process.stderr.write(`[primary-agent] mcp '${name}' not found in store, skip\n`);
    }
    if (!this.hasInjectedRuntime) this.runtime = res.runtime;
    const { config, adapter, handle } = res;

    const driver = new AgentDriver(row.id, config, handle, adapter);
    this.driver = driver;
    this.driverSub = subscribeDriverEvents(this, row.id);
    // driver.events$ → bus 翻译桥：否则 driver.started / turn.* 永远到不了前端。
    this.driverBusSub = attachDriverToBus(row.id, driver.events$, this.eventBus);

    try {
      await driver.start();
    } catch (err) {
      this.unsubscribeDriver();
      this.driver = null;
      await handle.kill().catch(() => {});
      throw err;
    }

    // 注册到全局 driverRegistry，供 ws-handler / commRouter / driverDispatcher 命中主 Agent。
    this.driverRegistry.register(row.id, driver);

    setStatus(row.id, 'RUNNING');
    this.eventBus.emit({
      ...makeBase('primary_agent.started', 'primary-agent'),
      agentId: row.id,
      cliType: row.cliType,
    });
    return readRow()!;
  }

  async stop(): Promise<void> {
    const row = readRow();
    const driver = this.driver;
    this.unsubscribeDriver();
    this.driver = null;
    this.setAgentState('idle');
    if (driver) {
      try { await driver.stop(); } catch { /* ignore */ }
    }
    if (row) {
      this.driverRegistry.unregister(row.id);
      setStatus(row.id, 'STOPPED');
      this.eventBus.emit({
        ...makeBase('primary_agent.stopped', 'primary-agent'),
        agentId: row.id,
      });
    }
  }

  isRunning(): boolean {
    return this.driver !== null;
  }

  unsubscribeDriver(): void {
    if (this.driverSub) {
      this.driverSub.unsubscribe();
      this.driverSub = null;
    }
    if (this.driverBusSub) {
      this.driverBusSub.unsubscribe();
      this.driverBusSub = null;
    }
  }
}

export const primaryAgent = new PrimaryAgent();
