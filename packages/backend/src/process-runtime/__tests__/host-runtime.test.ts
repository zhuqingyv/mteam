// HostRuntime 契约测试：用真实 Node 子进程，不 mock。
// 对应 REGRESSION.md §1.2 B1-B17 + W1-1b PGID 组播 + ProcessManager 自动注册。
import { describe, it, expect, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { HostRuntime } from '../host-runtime.js';
import type { LaunchSpec, RuntimeHandle } from '../types.js';
import { processManager } from '../../process-manager/index.js';

function baseSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runtime: 'host',
    command: 'node',
    args: [],
    env: { PATH: process.env.PATH ?? '' },
    cwd: process.cwd(),
    ...overrides,
  };
}

async function readAllUtf8(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const len = chunks.reduce((a, b) => a + b.byteLength, 0);
  const buf = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function waitExit(h: RuntimeHandle): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    h.onExit((code, signal) => resolve({ code, signal }));
  });
}

const handles: RuntimeHandle[] = [];
function track<T extends RuntimeHandle>(h: T): T { handles.push(h); return h; }

afterEach(async () => {
  while (handles.length) {
    const h = handles.pop()!;
    try { await h.kill(); } catch { /* ignore */ }
  }
});

describe('HostRuntime', () => {
  it('B1: spawn 能从 stdout 读到子进程输出', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdout.write('hello')"],
    })));
    const out = await readAllUtf8(h.stdout);
    expect(out).toBe('hello');
  });

  it('B2: stdin 写入能被子进程读到', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdin.on('data', d => { process.stdout.write(d); process.exit(0); });"],
    })));
    const w = h.stdin.getWriter();
    await w.write(new TextEncoder().encode('ping'));
    await w.close();
    const out = await readAllUtf8(h.stdout);
    expect(out).toBe('ping');
  });

  it('B3: onExit 正常退出 code=0', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({ args: ['-e', 'process.exit(0)'] })));
    const r = await waitExit(h);
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
  });

  it('B4: onExit 异常退出 code=2', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({ args: ['-e', 'process.exit(2)'] })));
    const r = await waitExit(h);
    expect(r.code).toBe(2);
    expect(r.signal).toBeNull();
  });

  it('B5: onExit 重复注册抛错', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({ args: ['-e', 'process.exit(0)'] })));
    h.onExit(() => { /* noop */ });
    expect(() => h.onExit(() => { /* noop */ })).toThrow('onExit already registered');
  });

  it('B6: kill SIGTERM 能杀掉可优雅退出的进程', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })));
    const exit = waitExit(h);
    await h.kill();
    const r = await exit;
    expect(r.signal === 'SIGTERM' || r.code === 0).toBe(true);
  });

  it('B7: kill 对忽略 SIGTERM 的进程 2s 内升级 SIGKILL', async () => {
    const rt = new HostRuntime();
    // 子进程先 write 'ready' 表明 handler 已注册，再 setInterval 保活
    const script = `process.on('SIGTERM', () => { process.stderr.write('trap\\n'); });
                    process.stdout.write('ready');
                    setInterval(() => {}, 1000);`;
    const h = track(await rt.spawn(baseSpec({ args: ['-e', script] })));
    // 等子进程真正就绪（收到 'ready'）再发 SIGTERM，避免 handler 注册前被杀
    const reader = h.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('ready');
    reader.releaseLock();

    const exit = waitExit(h);
    const t0 = Date.now();
    await h.kill();
    const r = await exit;
    const dt = Date.now() - t0;
    expect(r.signal).toBe('SIGKILL');
    expect(dt).toBeGreaterThanOrEqual(1500);
    expect(dt).toBeLessThan(4000);
  }, 8000);

  it('B8: kill 幂等 —— 两次调用都 resolve，不抛', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })));
    let exits = 0;
    h.onExit(() => { exits++; });
    await Promise.all([h.kill(), h.kill()]);
    // 给事件循环一拍让 onExit 派发
    await new Promise(r => setTimeout(r, 50));
    expect(exits).toBe(1);
  });

  it('B9: isAvailable(node) === true', async () => {
    expect(await new HostRuntime().isAvailable('node')).toBe(true);
  });

  it('B10: isAvailable(不存在的 cli) === false', async () => {
    expect(await new HostRuntime().isAvailable('definitely-not-a-real-cli-xyz-12345')).toBe(false);
  });

  it('B11: env 透传', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdout.write(process.env.FOO || 'nope')"],
      env: { FOO: 'bar', PATH: process.env.PATH ?? '' },
    })));
    expect(await readAllUtf8(h.stdout)).toBe('bar');
  });

  it('B12: cwd 生效', async () => {
    const rt = new HostRuntime();
    const tmp = realpathSync(tmpdir());
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: tmp,
    })));
    expect(await readAllUtf8(h.stdout)).toBe(tmp);
  });

  it('B13: runtime=docker 抛错', async () => {
    const rt = new HostRuntime();
    await expect(rt.spawn(baseSpec({ runtime: 'docker' }))).rejects.toThrow(/HostRuntime.*docker/);
  });

  it('B14: stdio.stderr=pipe 可通过', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'process.exit(0)'],
      stdio: { stderr: 'pipe' },
    })));
    const r = await waitExit(h);
    expect(r.code).toBe(0);
  });

  it('B15: destroy 幂等且不抛', async () => {
    const rt = new HostRuntime();
    await rt.destroy();
    await rt.destroy();
  });

  it('B16: pid 是正整数', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({ args: ['-e', 'setTimeout(() => {}, 500)'] })));
    expect(typeof h.pid).toBe('number');
    expect(h.pid as number).toBeGreaterThan(0);
  });

  it('B17: 多实例互不影响', async () => {
    const rt = new HostRuntime();
    const h1 = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdout.write('alpha')"],
    })));
    const h2 = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdout.write('beta')"],
    })));
    const [a, b] = await Promise.all([readAllUtf8(h1.stdout), readAllUtf8(h2.stdout)]);
    expect(a).toBe('alpha');
    expect(b).toBe('beta');
  });

  it('B18: spawn 自动 processManager.register；exit 后 unregister', async () => {
    const rt = new HostRuntime();
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH ?? '', TEAM_HUB_PROCESS_OWNER: 'test-owner' },
    })));
    const pid = h.pid as number;
    // register 时序：spawn 返回时已 register
    expect(processManager.get(pid)?.owner).toBe('test-owner');
    await waitExit(h);
    // 给事件循环一拍让 once('exit') 派发 unregister
    await new Promise(r => setTimeout(r, 50));
    expect(processManager.get(pid)).toBeUndefined();
  });

  it('B19: F1 PGID 组播 —— kill 后孙子进程全退', async () => {
    const rt = new HostRuntime();
    // 父进程 fork bash 起孙子，打印 grandchild pid 到 stdout
    const script = `const cp = require('child_process');
                    const g = cp.spawn('sleep', ['30'], { stdio: 'ignore', detached: false });
                    process.stdout.write(String(g.pid));
                    setInterval(() => {}, 1000);`;
    const h = track(await rt.spawn(baseSpec({ args: ['-e', script] })));
    const reader = h.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const grandPid = Number(new TextDecoder().decode(value));
    expect(grandPid).toBeGreaterThan(0);

    const exit = waitExit(h);
    await h.kill();
    await exit;
    // 给内核一拍回收 PGID 组播
    await new Promise(r => setTimeout(r, 300));
    // pgrep -P <parent> 应该为空
    const pg = spawnSync('pgrep', ['-P', String(h.pid)], { encoding: 'utf8' });
    expect(pg.stdout.trim()).toBe('');
    // 孙子进程本身也应该被 PGID 组播带走
    const alive = spawnSync('kill', ['-0', String(grandPid)]);
    expect(alive.status).not.toBe(0); // kill -0 成功返 0，不存在返非 0
  }, 10000);
});
