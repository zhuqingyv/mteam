import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import { cliManager } from '../cli-scanner/manager.js';
import { AgentDriver } from '../agent-driver/driver.js';
import { readRow, upsertConfig, setStatus } from './repo.js';
import { buildDriverConfig } from './driver-config.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from './types.js';

export class PrimaryAgent {
  private driver: AgentDriver | null = null;
  private driverSub: Subscription | null = null;

  constructor(private readonly eventBus: EventBus = defaultBus) {}

  boot(): void {
    const row = readRow();
    if (!row) return;
    if (row.status === 'RUNNING') setStatus(row.id, 'STOPPED');
    if (!cliManager.isAvailable(row.cliType)) {
      process.stderr.write(
        `[primary-agent] boot: cli '${row.cliType}' unavailable, skip auto-start\n`,
      );
      return;
    }
    this.start().catch((err) => {
      process.stderr.write(
        `[primary-agent] auto-start failed: ${(err as Error).message}\n`,
      );
    });
  }

  async teardown(): Promise<void> {
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

    const { config, skipped } = buildDriverConfig({ row });
    for (const name of skipped) {
      process.stderr.write(
        `[primary-agent] mcp '${name}' not found in store, skip\n`,
      );
    }

    const driver = new AgentDriver(row.id, config);
    this.driver = driver;
    this.subscribeDriverEvents(row.id);

    try {
      await driver.start();
    } catch (err) {
      this.unsubscribeDriver();
      this.driver = null;
      throw err;
    }

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
    if (driver) {
      try { await driver.stop(); } catch { /* ignore */ }
    }
    if (row) {
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

  private subscribeDriverEvents(agentId: string): void {
    // AgentDriver 事件走全局 bus（driver 模块硬编码）。
    // 只订阅自己这个 driverId，防止多实例交叉触发。
    const sub = defaultBus.events$.subscribe((ev) => {
      if (ev.type === 'driver.error') {
        if (ev.driverId !== agentId) return;
        process.stderr.write(
          `[primary-agent] driver error: ${ev.message}\n`,
        );
        void this.handleDriverFailure(agentId);
      } else if (ev.type === 'driver.stopped') {
        if (ev.driverId !== agentId) return;
        this.handleDriverStopped(agentId);
      }
    });
    this.driverSub = sub;
  }

  private unsubscribeDriver(): void {
    if (this.driverSub) {
      this.driverSub.unsubscribe();
      this.driverSub = null;
    }
  }

  private async handleDriverFailure(agentId: string): Promise<void> {
    if (!this.driver) return;
    const d = this.driver;
    this.unsubscribeDriver();
    this.driver = null;
    try { await d.stop(); } catch { /* ignore */ }
    setStatus(agentId, 'STOPPED');
    this.eventBus.emit({
      ...makeBase('primary_agent.stopped', 'primary-agent'),
      agentId,
    });
  }

  private handleDriverStopped(agentId: string): void {
    if (!this.driver) return;
    // driver 自己发的 stopped 事件：子进程挂了，同步 DB 状态。
    this.unsubscribeDriver();
    this.driver = null;
    setStatus(agentId, 'STOPPED');
    this.eventBus.emit({
      ...makeBase('primary_agent.stopped', 'primary-agent'),
      agentId,
    });
  }
}

export const primaryAgent = new PrimaryAgent();
