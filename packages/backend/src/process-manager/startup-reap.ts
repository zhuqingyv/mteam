// Phase Reliability W2-11：启动自清扫。
// backend 上次没走正常 shutdown（kill -9 / 崩溃 / 断电）时，snapshot 里会留着
// 一批遗留 pid。启动时读 snapshot：还活着的按 PGID SIGTERM→2s→SIGKILL 收走
// （reason='orphan'），自然已退的只清 tempFiles（reason='stale_temp'）。
// 完成后覆写空 snapshot。best-effort：任何异常吞掉，不阻塞启动。
import { unlink } from 'node:fs/promises';
import type { ProcessManager, SnapshotEntry, SnapshotFile } from './manager.js';

const REAP_GRACE_MS = 2000;

export interface StartupReapDeps {
  manager: ProcessManager;
  snapshotPath: string;
  emit?: (ev: { pid: number; owner: string | null; reason: 'orphan' | 'stale_temp' }) => void;
  now?: () => number;
}

export async function bootstrapReap(deps: StartupReapDeps): Promise<void> {
  const { manager, snapshotPath, emit } = deps;
  let snapshot: SnapshotFile | null = null;
  try {
    snapshot = await manager.readSnapshot(snapshotPath);
  } catch (err) {
    process.stderr.write(`[startup-reap] read snapshot failed: ${String(err)}\n`);
  }
  if (snapshot) {
    const entries: SnapshotEntry[] = snapshot.entries.length
      ? snapshot.entries
      : snapshot.pids.map((pid) => ({ pid, owner: null, tempFiles: [] }));
    const alive: SnapshotEntry[] = [];
    const dead: SnapshotEntry[] = [];
    for (const e of entries) {
      if (isAlive(e.pid)) alive.push(e);
      else dead.push(e);
    }
    if (alive.length) {
      for (const e of alive) signalGroup(e.pid, 'SIGTERM');
      await new Promise<void>((r) => setTimeout(r, REAP_GRACE_MS).unref?.());
      for (const e of alive) if (isAlive(e.pid)) signalGroup(e.pid, 'SIGKILL');
    }
    for (const e of [...alive, ...dead]) {
      await unlinkAll(e.tempFiles);
      emit?.({ pid: e.pid, owner: e.owner, reason: alive.includes(e) ? 'orphan' : 'stale_temp' });
    }
  }
  try {
    await manager.snapshot(snapshotPath); // 覆写为当前（空）台账
  } catch (err) {
    process.stderr.write(`[startup-reap] write empty snapshot failed: ${String(err)}\n`);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); return; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // 已死
    try { process.kill(pid, sig); } catch { /* best-effort */ }
  }
}

async function unlinkAll(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') process.stderr.write(`[startup-reap] unlink ${p}: ${String(err)}\n`);
    }
  }
}
