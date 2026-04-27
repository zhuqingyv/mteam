// startup-reap 单测：用真实 pid 快照 + child_process 起一个 `sleep` 子进程
// 验证 alive path；dead path 用已不存在的假 pid。emit / tempFiles 清理走桩。
import { describe, it, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type SnapshotFile } from '../manager.js';
import { bootstrapReap } from '../startup-reap.js';

type Reaped = { pid: number; owner: string | null; reason: 'orphan' | 'stale_temp' };

async function writeSnapshot(path: string, snap: SnapshotFile): Promise<void> {
  await writeFile(path, JSON.stringify(snap), 'utf8');
}

function findDeadPid(): number {
  // 从 999999 向下找一个不存在的 pid。macOS 默认 pid 上限 99999，这里几乎肯定 ESRCH。
  for (let pid = 999999; pid > 900000; pid--) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no dead pid found');
}

async function waitMs(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe('bootstrapReap', () => {
  it('snapshot 文件不存在：写空 snapshot，不 emit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'missing.json');
    const pm = new ProcessManager();
    const emitted: Reaped[] = [];
    await bootstrapReap({ manager: pm, snapshotPath: file, emit: (e) => emitted.push(e) });
    expect(emitted).toEqual([]);
    await waitMs(150);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.pids).toEqual([]);
    expect(parsed.entries).toEqual([]);
    expect(typeof parsed.writtenAt).toBe('string');
  });

  it('dead pid：emit stale_temp + 清 tempFiles + 不 kill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'snap.json');
    const tempA = join(dir, 'a');
    const tempB = join(dir, 'b');
    await writeFile(tempA, 'x');
    await writeFile(tempB, 'y');
    const deadPid = findDeadPid();
    await writeSnapshot(file, {
      pids: [deadPid],
      entries: [{ pid: deadPid, owner: 'primary-agent', tempFiles: [tempA, tempB] }],
      writtenAt: new Date().toISOString(),
    });

    const pm = new ProcessManager();
    const emitted: Reaped[] = [];
    await bootstrapReap({ manager: pm, snapshotPath: file, emit: (e) => emitted.push(e) });

    expect(emitted).toEqual([{ pid: deadPid, owner: 'primary-agent', reason: 'stale_temp' }]);
    await expect(stat(tempA)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(tempB)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('alive pid：SIGTERM 组播 → emit orphan → 清 tempFiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'snap.json');
    const temp = join(dir, 't');
    await writeFile(temp, 'x');

    // 起一个 detached 进程，自成进程组；PGID == child.pid。sleep 10 足够跨过 reap。
    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
    child.unref();
    if (!child.pid) throw new Error('spawn failed');
    const pid = child.pid;
    await waitMs(50); // 等 setsid 稳定
    let exited = false;
    child.once('exit', () => { exited = true; });

    await writeSnapshot(file, {
      pids: [pid],
      entries: [{ pid, owner: 'member', tempFiles: [temp] }],
      writtenAt: new Date().toISOString(),
    });

    const pm = new ProcessManager();
    const emitted: Reaped[] = [];
    await bootstrapReap({ manager: pm, snapshotPath: file, emit: (e) => emitted.push(e) });

    expect(emitted).toEqual([{ pid, owner: 'member', reason: 'orphan' }]);
    await waitMs(200);
    expect(exited).toBe(true);
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);

  it('混合：alive + dead 分别 emit orphan / stale_temp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'snap.json');

    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
    child.unref();
    if (!child.pid) throw new Error('spawn failed');
    const alivePid = child.pid;
    const deadPid = findDeadPid();

    await writeSnapshot(file, {
      pids: [alivePid, deadPid],
      entries: [
        { pid: alivePid, owner: 'a', tempFiles: [] },
        { pid: deadPid, owner: 'b', tempFiles: [] },
      ],
      writtenAt: new Date().toISOString(),
    });

    const pm = new ProcessManager();
    const emitted: Reaped[] = [];
    await bootstrapReap({ manager: pm, snapshotPath: file, emit: (e) => emitted.push(e) });

    const byPid = new Map(emitted.map(e => [e.pid, e.reason]));
    expect(byPid.get(alivePid)).toBe('orphan');
    expect(byPid.get(deadPid)).toBe('stale_temp');
    expect(emitted.length).toBe(2);

    try { process.kill(alivePid, 'SIGKILL'); } catch { /* 已被 reap 走了 */ }
  }, 15000);

  it('老版本 snapshot（只有 pids 字段）：按 dead 处理一遍，owner=null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'snap.json');
    const deadPid = findDeadPid();
    await writeFile(file, JSON.stringify({ pids: [deadPid], writtenAt: new Date().toISOString() }));

    const pm = new ProcessManager();
    const emitted: Reaped[] = [];
    await bootstrapReap({ manager: pm, snapshotPath: file, emit: (e) => emitted.push(e) });

    expect(emitted).toEqual([{ pid: deadPid, owner: null, reason: 'stale_temp' }]);
  });

  it('reap 后 snapshot 被覆写为当前台账（无进程 = 空）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-'));
    const file = join(dir, 'snap.json');
    const deadPid = findDeadPid();
    await writeSnapshot(file, {
      pids: [deadPid],
      entries: [{ pid: deadPid, owner: null, tempFiles: [] }],
      writtenAt: new Date().toISOString(),
    });

    const pm = new ProcessManager();
    await bootstrapReap({ manager: pm, snapshotPath: file });
    await waitMs(150);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.pids).toEqual([]);
    expect(parsed.entries).toEqual([]);
  });
});
