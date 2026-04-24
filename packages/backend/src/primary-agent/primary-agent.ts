import type { IPty } from 'node-pty';
import { bus as defaultBus, type EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import { cliManager } from '../cli-scanner/manager.js';
import { CommClient } from '../mcp/comm-client.js';
import { readRow, upsertConfig, setStatus } from './repo.js';
import { spawnPrimaryCli, removeMcpConfig } from './spawner.js';
import type { PrimaryAgentConfig, PrimaryAgentRow } from './types.js';

const KILL_GRACE_MS = 2000;

export class PrimaryAgent {
  private handle: IPty | null = null;
  private comm: CommClient | null = null;
  private mcpConfigPath: string | null = null;

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

  configure(config: PrimaryAgentConfig): PrimaryAgentRow {
    const next = upsertConfig(config);
    this.eventBus.emit({
      ...makeBase('primary_agent.configured', 'primary-agent'),
      agentId: next.id,
      cliType: next.cliType,
      name: next.name,
    });
    return next;
  }

  getConfig(): PrimaryAgentRow | null {
    return readRow();
  }

  async start(): Promise<PrimaryAgentRow> {
    const row = readRow();
    if (!row) throw new Error('primary agent not configured');
    if (this.handle) return row;
    if (!cliManager.isAvailable(row.cliType)) {
      throw new Error(`cli '${row.cliType}' is not available`);
    }

    const spawned = spawnPrimaryCli({
      agentId: row.id,
      name: row.name,
      cliType: row.cliType,
      systemPrompt: row.systemPrompt,
      mcpConfig: row.mcpConfig,
    });
    this.handle = spawned.handle;
    this.mcpConfigPath = spawned.mcpConfigPath;

    spawned.handle.onExit(({ exitCode, signal }) => {
      process.stderr.write(
        `[primary-agent] exited code=${exitCode} signal=${signal ?? 0}\n`,
      );
      this.onExited(row.id);
    });

    const comm = new CommClient(spawned.commSock, spawned.selfAddress);
    try {
      await comm.ensureReady();
    } catch (err) {
      this.killHandle();
      removeMcpConfig(this.mcpConfigPath);
      this.mcpConfigPath = null;
      throw new Error(`comm register failed: ${(err as Error).message}`);
    }
    this.comm = comm;

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
    this.killHandle();
    if (this.comm) {
      try { this.comm.close(); } catch { /* ignore */ }
      this.comm = null;
    }
    removeMcpConfig(this.mcpConfigPath);
    this.mcpConfigPath = null;
    if (row) {
      setStatus(row.id, 'STOPPED');
      this.eventBus.emit({
        ...makeBase('primary_agent.stopped', 'primary-agent'),
        agentId: row.id,
      });
    }
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  private onExited(agentId: string): void {
    this.handle = null;
    if (this.comm) {
      try { this.comm.close(); } catch { /* ignore */ }
      this.comm = null;
    }
    removeMcpConfig(this.mcpConfigPath);
    this.mcpConfigPath = null;
    setStatus(agentId, 'STOPPED');
    this.eventBus.emit({
      ...makeBase('primary_agent.stopped', 'primary-agent'),
      agentId,
    });
  }

  private killHandle(): void {
    if (!this.handle) return;
    const h = this.handle;
    try { h.kill('SIGTERM'); } catch { /* already exited */ }
    const pid = h.pid;
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }, KILL_GRACE_MS);
    this.handle = null;
  }
}

export const primaryAgent = new PrimaryAgent();
