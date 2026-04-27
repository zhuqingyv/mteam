// DockerRuntime —— 通过 docker CLI 启动容器化进程的 ProcessRuntime 实现。
// 契约见 ./types.ts 与 docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md。
// W1-1b: detached 起进程组 + PGID 组播 kill + 自动 ProcessManager 注册。
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { platform } from 'node:os';
import type { ProcessRuntime, LaunchSpec, RuntimeHandle } from './types.js';
import { processManager } from '../process-manager/index.js';
import { containerName, isExecutableOnPath } from './docker-cli.js';

// Re-export：保持公共 API；上层和测试继续从 docker-runtime.ts 导入。
export { containerName } from './docker-cli.js';

const KILL_GRACE_MS = 2000;
const DEFAULT_IMAGE = 'mteam-agent:latest';
const DEFAULT_NETWORK = 'mteam-bridge';
const WORKSPACE_DIR = '/workspace';

export interface DockerRuntimeConfig {
  /** 容器镜像名；缺省 'mteam-agent:latest'。 */
  image?: string;
  /** docker 网络；缺省 'mteam-bridge'，容器由此访问 host.docker.internal。 */
  network?: string;
  /** 额外 docker run 参数，追加在 image 前（Stage 5 volume/user hook 用）。 */
  extraDockerArgs?: string[];
  /** docker CLI 可执行名/绝对路径，缺省 'docker'。测试用。 */
  dockerBin?: string;
}

export class DockerRuntime implements ProcessRuntime {
  private readonly image: string;
  private readonly network: string;
  private readonly extra: string[];
  private readonly docker: string;

  constructor(cfg: DockerRuntimeConfig = {}) {
    this.image = cfg.image ?? DEFAULT_IMAGE;
    if (!this.image) throw new Error('DockerRuntime requires image');
    this.network = cfg.network ?? DEFAULT_NETWORK;
    this.extra = cfg.extraDockerArgs ?? [];
    this.docker = cfg.dockerBin ?? 'docker';
  }

  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    if (spec.runtime !== 'docker') {
      throw new Error(`DockerRuntime cannot handle runtime=${spec.runtime}`);
    }
    // 预检 docker CLI 是否可执行。Bun 在 ENOENT 下会穿透 spawn 的 try/catch 直接抛到
    // caller，所以同步探测一次给出清晰报错，区分于"镜像缺失/网络缺失"这类运行期错误。
    if (!isExecutableOnPath(this.docker)) {
      throw new Error(
        `DockerRuntime: 无法启动 docker CLI ('${this.docker}')，请确认已安装 Docker 且 PATH 可达`,
      );
    }
    const args = this.buildRunArgs(spec);
    const child = spawn(this.docker, args, {
      stdio: ['pipe', 'pipe', spec.stdio?.stderr ?? 'inherit'],
      detached: true, // F1 PGID 组播前提
    });
    if (child.pid === undefined) {
      throw new Error(
        `DockerRuntime: 无法启动 docker CLI ('${this.docker}')`,
      );
    }
    return createHandle(child, spec);
  }

  async isAvailable(_cliType: string): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.docker, ['image', 'inspect', this.image], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      p.once('error', () => resolve(false));
      p.once('exit', (code) => resolve(code === 0));
    });
  }

  async destroy(): Promise<void> {
    // docker CLI 本身无持久连接
  }

  private buildRunArgs(spec: LaunchSpec): string[] {
    const instanceId = spec.env.ROLE_INSTANCE_ID ?? 'anon';
    const name = containerName(instanceId);
    const args = [
      'run', '-i', '--rm',
      '--name', name,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--network', this.network,
    ];
    if (platform() === 'linux') {
      args.push('--add-host=host.docker.internal:host-gateway');
    }
    // cwd 映射：host 路径 volume mount 到 /workspace，并把容器 cwd 设为 /workspace。
    // 不 mount 整个文件系统，只 mount spec.cwd 一层。
    if (spec.cwd) {
      args.push('-v', `${spec.cwd}:${WORKSPACE_DIR}`);
      args.push('-w', WORKSPACE_DIR);
    }
    for (const [k, v] of Object.entries(spec.env)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(...this.extra, this.image, spec.command, ...spec.args);
    return args;
  }
}

export function createDockerRuntime(cfg: DockerRuntimeConfig): ProcessRuntime {
  return new DockerRuntime(cfg);
}

function createHandle(child: ChildProcess, spec: LaunchSpec): RuntimeHandle {
  if (child.pid === undefined) {
    throw new Error('docker CLI spawn returned no pid');
  }
  const pid = child.pid;
  const stdin = child.stdin
    ? (Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>)
    : emptyWritable();
  const stdout = child.stdout
    ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
    : emptyReadable();

  let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const exitWaiters: Array<() => void> = [];

  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    try { processManager.unregister(pid); } catch { /* ignore */ }
    if (exitCb) exitCb(code, signal);
    for (const w of exitWaiters.splice(0)) w();
  });

  let killing = false;
  const kill = async (signal: string = 'SIGTERM'): Promise<void> => {
    if (exited) return;
    const wait = new Promise<void>((resolve) => {
      if (exited) { resolve(); return; }
      exitWaiters.push(resolve);
    });
    if (!killing) {
      killing = true;
      killGroup(child, pid, signal);
      setTimeout(() => {
        if (!exited) killGroup(child, pid, 'SIGKILL');
      }, KILL_GRACE_MS).unref?.();
    }
    await wait;
  };

  processManager.register({
    id: String(pid),
    pid,
    owner: spec.env.TEAM_HUB_PROCESS_OWNER ?? 'runtime',
    kill,
  });

  return {
    stdin,
    stdout,
    pid,
    kill,
    onExit(cb) {
      if (exitCb) throw new Error('onExit already registered');
      exitCb = cb;
      if (exited) cb(exitCode, exitSignal);
    },
  };
}

function killGroup(child: ChildProcess, pid: number, signal: string): void {
  try {
    process.kill(-pid, signal as NodeJS.Signals);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ESRCH') {
      try { child.kill(signal as NodeJS.Signals); } catch { /* already gone */ }
    }
  }
}

function emptyWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({ write() { /* noop */ } });
}

function emptyReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}
