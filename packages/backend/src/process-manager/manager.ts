// ProcessManager —— 进程台账 + 统一 kill。
// 纯净层：仅依赖 node 内置。不 import bus/domain/db/http/comm/业务。
// 契约：docs/phase-reliability/TASK-LIST.md W1-1。
import { unlink, writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type KillFn = (signal?: string) => Promise<void>;

export interface ManagedProcess {
  readonly id: string;
  readonly pid: number;
  readonly owner: string;
  readonly spawnedAt: number;
  readonly tempFiles: readonly string[];
}

export interface RegisterEntry {
  readonly id: string;
  readonly pid: number;
  readonly owner: string;
  readonly kill: KillFn;
}

export interface ProcessStats {
  count: number;
  byOwner: Record<string, number>;
}

export type ProcessExitListener = (proc: ManagedProcess) => void;

interface InternalEntry extends RegisterEntry {
  spawnedAt: number;
  tempFiles: Set<string>;
}

const KILL_GRACE_MS = 2000;
const SNAPSHOT_DEBOUNCE_MS = 100;

export class ProcessManager {
  private readonly byPid = new Map<number, InternalEntry>();
  private readonly exitListeners = new Set<ProcessExitListener>();
  private snapshotPath: string | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  register(entry: RegisterEntry): void {
    if (this.byPid.has(entry.pid)) return; // 幂等
    this.byPid.set(entry.pid, { ...entry, spawnedAt: Date.now(), tempFiles: new Set() });
    this.scheduleSnapshot();
  }

  unregister(pid: number): void {
    const entry = this.byPid.get(pid);
    if (!entry) return;
    this.byPid.delete(pid);
    const snap = toSnapshot(entry);
    for (const cb of this.exitListeners) {
      try { cb(snap); } catch (err) {
        process.stderr.write(`[process-manager] exit listener threw: ${String(err)}\n`);
      }
    }
    for (const file of entry.tempFiles) {
      void unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') process.stderr.write(`[process-manager] unlink ${file}: ${err.message}\n`);
      });
    }
    this.scheduleSnapshot();
  }

  get(pid: number): ManagedProcess | undefined {
    const entry = this.byPid.get(pid);
    return entry ? toSnapshot(entry) : undefined;
  }

  listAll(): ManagedProcess[] {
    return Array.from(this.byPid.values(), toSnapshot);
  }

  attachTempFiles(pid: number, paths: string[]): void {
    const entry = this.byPid.get(pid);
    if (!entry) return; // pid 已不存在（spawn 失败/已退出），静默
    for (const p of paths) entry.tempFiles.add(p);
  }

  async killAll(): Promise<void> {
    const entries = Array.from(this.byPid.values());
    await Promise.allSettled(entries.map(e => e.kill('SIGTERM')));
    await new Promise<void>(r => setTimeout(r, KILL_GRACE_MS).unref?.());
    const survivors = entries.filter(e => this.byPid.has(e.pid));
    await Promise.allSettled(survivors.map(e => e.kill('SIGKILL')));
  }

  onProcessExit(cb: ProcessExitListener): () => void {
    this.exitListeners.add(cb);
    return () => { this.exitListeners.delete(cb); };
  }

  stats(): ProcessStats {
    const byOwner: Record<string, number> = {};
    for (const e of this.byPid.values()) byOwner[e.owner] = (byOwner[e.owner] ?? 0) + 1;
    return { count: this.byPid.size, byOwner };
  }

  async snapshot(path: string): Promise<void> {
    this.snapshotPath = path;
    await this.writeSnapshotNow();
  }

  async readSnapshot(path: string): Promise<SnapshotFile | null> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || !Array.isArray(parsed.pids)) return null;
      const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const entries: SnapshotEntry[] = [];
      for (const e of rawEntries) {
        if (!e || typeof e.pid !== 'number') continue;
        entries.push({
          pid: e.pid,
          owner: typeof e.owner === 'string' ? e.owner : null,
          tempFiles: Array.isArray(e.tempFiles)
            ? e.tempFiles.filter((x: unknown): x is string => typeof x === 'string')
            : [],
        });
      }
      return {
        pids: parsed.pids.filter((x: unknown): x is number => typeof x === 'number'),
        entries,
        writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '',
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private scheduleSnapshot(): void {
    if (!this.snapshotPath || this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.writeSnapshotNow();
    }, SNAPSHOT_DEBOUNCE_MS);
    this.snapshotTimer.unref?.();
  }

  private async writeSnapshotNow(): Promise<void> {
    if (!this.snapshotPath) return;
    const path = this.snapshotPath;
    const entries: SnapshotEntry[] = Array.from(this.byPid.values(), (e) => ({
      pid: e.pid,
      owner: e.owner,
      tempFiles: Array.from(e.tempFiles),
    }));
    const payload: SnapshotFile = {
      pids: entries.map((e) => e.pid),
      entries,
      writtenAt: new Date().toISOString(),
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(payload), 'utf8');
    } catch (err) {
      process.stderr.write(`[process-manager] snapshot write failed: ${String(err)}\n`);
    }
  }
}

export interface SnapshotEntry {
  pid: number;
  owner: string | null;
  tempFiles: string[];
}

export interface SnapshotFile {
  pids: number[];
  entries: SnapshotEntry[];
  writtenAt: string;
}

function toSnapshot(e: InternalEntry): ManagedProcess {
  return { id: e.id, pid: e.pid, owner: e.owner, spawnedAt: e.spawnedAt, tempFiles: Array.from(e.tempFiles) };
}
