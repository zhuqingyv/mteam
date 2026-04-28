// CliManager —— 本地 agent CLI 可用性的内存快照 + 轮询器。
// boot() 触发异步全量扫描（which + --version 并行），随后每 POLL_INTERVAL_MS 增量 diff，
// 状态翻转时 emit cli.available / cli.unavailable。getAll/isAvailable/getInfo 全读内存，
// 不阻塞（前端 HTTP 不会触发实际 spawn）。
//
// 首次扫描未完成期间 snapshot 为空，isAvailable 返回 false，getAll 走白名单兜底。
// primaryAgent.boot() 已有兜底：cli unavailable → 写 stderr 跳过。
//
// 扫描命令失败（未安装、超时、权限）一律兜成 available=false，不抛。
import { spawn } from 'node:child_process';
import { bus as defaultBus, type EventBus } from '../bus/index.js';
import { makeBase } from '../bus/helpers.js';
import { globalTicker } from '../ticker/ticker.js';
import type { Ticker } from '../ticker/types.js';
import type { CliInfo } from './types.js';

const POLL_TASK_ID = 'cli-scanner-poll';

const WHITELIST: readonly string[] = ['claude', 'codex'];
const SCAN_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 30_000;

function runCommandAsync(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), SCAN_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const out = stdout.trim();
      finish(out.length > 0 ? out : null);
    });
  });
}

async function scanOneAsync(name: string): Promise<CliInfo> {
  const path = await runCommandAsync('which', [name]);
  if (!path) return { name, available: false, path: null, version: null };
  const version = await runCommandAsync(name, ['--version']);
  return { name, available: true, path, version };
}

async function scanAllAsync(): Promise<Map<string, CliInfo>> {
  const entries = await Promise.all(
    WHITELIST.map(async (name) => [name, await scanOneAsync(name)] as const),
  );
  return new Map(entries);
}

export class CliManager {
  private snapshot: Map<string, CliInfo> = new Map();
  private scheduled = false;
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly eventBus: EventBus = defaultBus,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
    private readonly ticker: Ticker = globalTicker,
  ) {}

  // boot() 不阻塞：触发异步首次扫描，立即返回。
  // 调用方需要读快照前等待时，用 ready() 挂起。
  boot(): void {
    if (!this.readyPromise) {
      this.readyPromise = this.scanAndDiff();
    }
    if (this.scheduled) return;
    this.ticker.schedule({
      id: POLL_TASK_ID,
      fireAt: Date.now() + this.intervalMs,
      repeat: this.intervalMs,
      callback: () => { void this.poll(); },
    });
    this.scheduled = true;
  }

  // 等首次扫描完成。未 boot 时立即 resolve（调用方自己的责任）。
  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  teardown(): void {
    if (this.scheduled) {
      this.ticker.cancel(POLL_TASK_ID);
      this.scheduled = false;
    }
    this.snapshot.clear();
    this.readyPromise = null;
  }

  getAll(): CliInfo[] {
    return WHITELIST.map(
      (name) =>
        this.snapshot.get(name) ?? {
          name,
          available: false,
          path: null,
          version: null,
        },
    );
  }

  isAvailable(name: string): boolean {
    return this.snapshot.get(name)?.available === true;
  }

  getInfo(name: string): CliInfo | null {
    return this.snapshot.get(name) ?? null;
  }

  // refresh(): 立即重新扫描并 diff，返回最新快照。供 POST /api/cli/refresh 使用。
  async refresh(): Promise<CliInfo[]> {
    await this.poll();
    return this.getAll();
  }

  private async poll(): Promise<void> {
    await this.scanAndDiff();
  }

  private async scanAndDiff(): Promise<void> {
    const next = await scanAllAsync();
    for (const name of WHITELIST) {
      const prev = this.snapshot.get(name);
      const cur = next.get(name)!;
      if (!prev || prev.available !== cur.available) {
        this.emitTransition(prev, cur);
      }
    }
    this.snapshot = next;
  }

  private emitTransition(prev: CliInfo | undefined, cur: CliInfo): void {
    try {
      if (cur.available && cur.path) {
        this.eventBus.emit({
          ...makeBase('cli.available', 'cli-scanner'),
          cliName: cur.name,
          path: cur.path,
          version: cur.version,
        });
      } else if (prev && prev.available) {
        this.eventBus.emit({
          ...makeBase('cli.unavailable', 'cli-scanner'),
          cliName: cur.name,
        });
      }
    } catch (err) {
      process.stderr.write(
        `[cli-scanner] emit failed for ${cur.name}: ${(err as Error).message}\n`,
      );
    }
  }
}

export const cliManager = new CliManager();
