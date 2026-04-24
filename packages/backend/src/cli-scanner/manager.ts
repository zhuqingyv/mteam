// CliManager —— 本地 agent CLI 可用性的内存快照 + 轮询器。
// boot() 做一次全量扫描（which + --version），随后每 POLL_INTERVAL_MS 增量 diff，
// 状态翻转时 emit cli.available / cli.unavailable。getAll/isAvailable/getInfo 全读内存，
// 不阻塞（前端 HTTP 不会触发实际 spawn）。
//
// 扫描命令失败（未安装、超时、权限）一律兜成 available=false，不抛。
import { spawnSync } from 'node:child_process';
import { bus as defaultBus, type EventBus } from '../bus/index.js';
import { makeBase } from '../bus/helpers.js';
import type { CliInfo } from './types.js';

const WHITELIST: readonly string[] = ['claude', 'codex'];
const SCAN_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 30_000;

function runCommand(cmd: string, args: string[]): string | null {
  try {
    const res = spawnSync(cmd, args, {
      timeout: SCAN_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error || res.status !== 0) return null;
    const out = (res.stdout || '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function scanOne(name: string): CliInfo {
  const path = runCommand('which', [name]);
  if (!path) return { name, available: false, path: null, version: null };
  const version = runCommand(name, ['--version']);
  return { name, available: true, path, version };
}

function scanAll(): Map<string, CliInfo> {
  const snapshot = new Map<string, CliInfo>();
  for (const name of WHITELIST) {
    snapshot.set(name, scanOne(name));
  }
  return snapshot;
}

export class CliManager {
  private snapshot: Map<string, CliInfo> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly eventBus: EventBus = defaultBus,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  boot(): void {
    this.snapshot = scanAll();
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll();
    }, this.intervalMs);
    // 不让定时器阻止进程退出：测试和 SIGINT 路径依赖这一点。
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  teardown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.snapshot.clear();
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
  refresh(): CliInfo[] {
    this.poll();
    return this.getAll();
  }

  private poll(): void {
    const next = scanAll();
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
