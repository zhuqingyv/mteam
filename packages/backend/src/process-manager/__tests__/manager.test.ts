// ProcessManager 单元测试：不 mock 任何业务依赖，仅用 KillFn stub 演练台账。
// 对应 TASK-LIST.md W1-1 判据：幂等 / tempFiles unlink / attachTempFiles 幂等+pid 缺失静默 /
// 回调解绑 / snapshot 读写。
import { describe, it, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type ManagedProcess, type RegisterEntry } from '../manager.js';

const noopKill = async () => {};

function entry(pid: number, owner = 'test', kill: RegisterEntry['kill'] = noopKill): RegisterEntry {
  return { id: String(pid), pid, owner, kill };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe('ProcessManager.register / unregister', () => {
  it('register 同一 pid 幂等，不覆盖 spawnedAt / owner', async () => {
    const pm = new ProcessManager();
    pm.register(entry(1001, 'a'));
    const first = pm.get(1001)!;
    await waitMs(5);
    pm.register(entry(1001, 'b'));
    const second = pm.get(1001)!;
    expect(second.owner).toBe('a');
    expect(second.spawnedAt).toBe(first.spawnedAt);
  });

  it('unregister pid 不存在时静默', () => {
    const pm = new ProcessManager();
    expect(() => pm.unregister(9999)).not.toThrow();
  });

  it('listAll / get / stats 反映当前台账', () => {
    const pm = new ProcessManager();
    pm.register(entry(100, 'primary'));
    pm.register(entry(101, 'primary'));
    pm.register(entry(200, 'member'));
    expect(pm.listAll().length).toBe(3);
    expect(pm.get(100)?.owner).toBe('primary');
    expect(pm.stats()).toEqual({ count: 3, byOwner: { primary: 2, member: 1 } });
    pm.unregister(101);
    expect(pm.stats()).toEqual({ count: 2, byOwner: { primary: 1, member: 1 } });
  });
});

describe('ProcessManager.attachTempFiles', () => {
  it('pid 存在：追加 + 去重', () => {
    const pm = new ProcessManager();
    pm.register(entry(500));
    pm.attachTempFiles(500, ['/tmp/a', '/tmp/b']);
    pm.attachTempFiles(500, ['/tmp/b', '/tmp/c']); // b 去重
    expect(pm.get(500)?.tempFiles).toEqual(['/tmp/a', '/tmp/b', '/tmp/c']);
  });

  it('pid 不存在：静默 return，不抛', () => {
    const pm = new ProcessManager();
    expect(() => pm.attachTempFiles(404, ['/tmp/x'])).not.toThrow();
  });
});

describe('ProcessManager.unregister 副作用', () => {
  it('unlink tempFiles（真实文件）', async () => {
    const pm = new ProcessManager();
    const dir = await mkdtemp(join(tmpdir(), 'pm-unlink-'));
    const f1 = join(dir, 'f1'); const f2 = join(dir, 'f2');
    await writeFile(f1, 'x');
    await writeFile(f2, 'y');
    pm.register(entry(700));
    pm.attachTempFiles(700, [f1, f2]);
    pm.unregister(700);
    await waitMs(30);
    await expect(stat(f1)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f2)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tempFile 不存在（ENOENT）吞掉不抛', async () => {
    const pm = new ProcessManager();
    pm.register(entry(701));
    pm.attachTempFiles(701, ['/tmp/definitely-not-there-xyz-42']);
    expect(() => pm.unregister(701)).not.toThrow();
  });
});

describe('ProcessManager.onProcessExit', () => {
  it('回调被 unregister 触发；unsubscribe 后不再触发', () => {
    const pm = new ProcessManager();
    const seen: ManagedProcess[] = [];
    const off = pm.onProcessExit(p => { seen.push(p); });
    pm.register(entry(800));
    pm.unregister(800);
    expect(seen.length).toBe(1);
    expect(seen[0].pid).toBe(800);
    off();
    pm.register(entry(801));
    pm.unregister(801);
    expect(seen.length).toBe(1); // 解绑后不再加
  });

  it('一个 listener 抛错不影响其他 listener', () => {
    const pm = new ProcessManager();
    pm.onProcessExit(() => { throw new Error('boom'); });
    let ok = 0;
    pm.onProcessExit(() => { ok++; });
    pm.register(entry(900));
    pm.unregister(900);
    expect(ok).toBe(1);
  });
});

describe('ProcessManager.killAll', () => {
  it('SIGTERM → 2s 宽限 → SIGKILL 升级（stub 不退 pid）', async () => {
    const pm = new ProcessManager();
    const calls: string[] = [];
    pm.register(entry(1000, 'x', async (sig) => { calls.push(sig ?? 'SIGTERM'); }));
    const t0 = Date.now();
    await pm.killAll();
    const dt = Date.now() - t0;
    expect(calls[0]).toBe('SIGTERM');
    expect(calls).toContain('SIGKILL'); // 第二轮升级
    expect(dt).toBeGreaterThanOrEqual(1800);
  }, 8000);

  it('SIGTERM 后 unregister 则第二轮不再 SIGKILL', async () => {
    const pm = new ProcessManager();
    const calls: string[] = [];
    pm.register(entry(1100, 'x', async (sig) => {
      calls.push(sig ?? 'SIGTERM');
      pm.unregister(1100); // 模拟进程真的退了
    }));
    await pm.killAll();
    expect(calls).toEqual(['SIGTERM']);
  }, 8000);

  it('单个 kill 抛错不阻塞其他', async () => {
    const pm = new ProcessManager();
    const good: string[] = [];
    pm.register(entry(1200, 'x', async () => { throw new Error('nope'); }));
    pm.register(entry(1201, 'x', async (sig) => { good.push(sig ?? 'SIGTERM'); pm.unregister(1201); }));
    await pm.killAll();
    expect(good).toEqual(['SIGTERM']);
  }, 8000);
});

describe('ProcessManager.snapshot', () => {
  it('写快照 + readSnapshot 读回 pids', async () => {
    const pm = new ProcessManager();
    pm.register(entry(2000));
    pm.register(entry(2001));
    const dir = await mkdtemp(join(tmpdir(), 'pm-snap-'));
    const file = join(dir, 'snap.json');
    await pm.snapshot(file);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(new Set(parsed.pids)).toEqual(new Set([2000, 2001]));
    expect(typeof parsed.writtenAt).toBe('string');
    const read = await pm.readSnapshot(file);
    expect(read?.pids.sort()).toEqual([2000, 2001]);
  });

  it('readSnapshot 文件不存在 → null', async () => {
    const pm = new ProcessManager();
    const dir = await mkdtemp(join(tmpdir(), 'pm-snap-'));
    const read = await pm.readSnapshot(join(dir, 'missing.json'));
    expect(read).toBeNull();
  });

  it('register/unregister 后 debounce 写入最新快照', async () => {
    const pm = new ProcessManager();
    const dir = await mkdtemp(join(tmpdir(), 'pm-snap-'));
    const file = join(dir, 'snap.json');
    await pm.snapshot(file);
    pm.register(entry(3000));
    pm.register(entry(3001));
    await waitMs(200); // > 100ms debounce
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(new Set(parsed.pids)).toEqual(new Set([3000, 3001]));
    pm.unregister(3000);
    await waitMs(200);
    const parsed2 = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed2.pids).toEqual([3001]);
  });
});
