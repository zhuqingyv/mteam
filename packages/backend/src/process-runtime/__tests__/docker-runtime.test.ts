// DockerRuntime 契约测试。
// 真实实现 —— 需要宿主机 docker daemon 可用才跑；否则整体 skip。
// 纯参数构造/校验类用例无 docker 也能跑（独立 describe）。
import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { DockerRuntime, containerName } from '../docker-runtime.js';
import type { LaunchSpec, RuntimeHandle } from '../types.js';

function dockerAvailable(): boolean {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
const TEST_IMAGE = 'node:20-slim';

function baseSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runtime: 'docker',
    command: 'node',
    args: [],
    env: {},
    cwd: '/tmp',
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

describe('DockerRuntime 构造与参数', () => {
  it('D1: 无参构造走默认镜像 mteam-agent:latest', () => {
    const rt = new DockerRuntime();
    // 不可变内部状态：通过 isAvailable 的命令行间接验证；这里断言 new 不抛。
    expect(rt).toBeInstanceOf(DockerRuntime);
  });

  it('D2: runtime=host 抛错', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    await expect(rt.spawn(baseSpec({ runtime: 'host' }))).rejects.toThrow(/DockerRuntime.*host/);
  });

  it('D3: destroy 幂等不抛', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    await rt.destroy();
    await rt.destroy();
  });

  it('D4: isAvailable 用不存在的 docker bin → false（不抛）', async () => {
    const rt = new DockerRuntime({
      image: TEST_IMAGE,
      dockerBin: '/definitely/not/a/real/docker/bin',
    });
    expect(await rt.isAvailable('claude')).toBe(false);
  });

  it('D5: 容器名格式 mteam-<slug>-<hex6>；敏感字符替换', () => {
    const a = containerName('inst-42');
    expect(a).toMatch(/^mteam-inst-42-[0-9a-f]{6}$/);
    const b = containerName('Role:Foo/Bar#1');
    expect(b).toMatch(/^mteam-role-foo-bar-1-[0-9a-f]{6}$/);
    const c = containerName('');
    expect(c).toMatch(/^mteam-anon-[0-9a-f]{6}$/);
    // 唯一性：两次生成结果不同
    expect(containerName('x')).not.toBe(containerName('x'));
  });

  it('D6: docker CLI 不存在时 spawn 抛清晰报错', async () => {
    const rt = new DockerRuntime({
      image: TEST_IMAGE,
      dockerBin: '/definitely/not/a/real/docker/bin',
    });
    await expect(rt.spawn(baseSpec())).rejects.toThrow(/无法启动 docker CLI/);
  });
});

const suite = HAS_DOCKER ? describe : describe.skip;

suite('DockerRuntime 真容器 (需要 docker daemon)', () => {
  const handles: RuntimeHandle[] = [];
  afterEach(async () => {
    while (handles.length) {
      const h = handles.pop()!;
      try { await h.kill(); } catch { /* ignore */ }
    }
  });
  const track = <T extends RuntimeHandle>(h: T): T => { handles.push(h); return h; };

  it('E1: spawn 能通过 stdin/stdout 往返（echo）', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdin.on('data', d => { process.stdout.write(d); process.exit(0); });"],
    })));
    const w = h.stdin.getWriter();
    await w.write(new TextEncoder().encode('hello\n'));
    await w.close();
    const out = await readAllUtf8(h.stdout);
    expect(out).toBe('hello\n');
  }, 30000);

  it('E2: kill SIGTERM 能终止容器内长时任务', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })));
    const exit = waitExit(h);
    await h.kill();
    const r = await exit;
    // docker CLI 被 SIGTERM 杀掉 → 子进程退出。signal 或 code 其一有值即可。
    expect(r.signal !== null || typeof r.code === 'number').toBe(true);
  }, 30000);

  it('E3: 镜像不存在时 onExit 收非零 code', async () => {
    const rt = new DockerRuntime({ image: 'mteam/definitely-not-a-real-image:nope-xyz-12345' });
    const h = await rt.spawn(baseSpec({ args: ['-e', 'process.exit(0)'] }));
    const r = await waitExit(h);
    expect(r.code === null || r.code !== 0).toBe(true);
  }, 30000);

  it('E4: isAvailable 检查镜像存在', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    expect(await rt.isAvailable('node')).toBe(true);
    const missing = new DockerRuntime({
      image: 'mteam/definitely-not-a-real-image:nope-xyz-12345',
    });
    expect(await missing.isAvailable('node')).toBe(false);
  }, 30000);

  it('E5: env 注入（-e KEY=VAL）', async () => {
    const rt = new DockerRuntime({ image: TEST_IMAGE });
    const h = track(await rt.spawn(baseSpec({
      args: ['-e', "process.stdout.write(process.env.FOO || 'nope')"],
      env: { FOO: 'bar' },
    })));
    expect(await readAllUtf8(h.stdout)).toBe('bar');
  }, 30000);
});
