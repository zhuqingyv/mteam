// HostRuntime —— 在宿主机上用 child_process.spawn 启动进程的 ProcessRuntime 实现。
// 契约见 ./types.ts 与 docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md。
// W1-1b: detached 起进程组 + PGID 组播 kill + 自动 ProcessManager 注册。
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { access, constants } from 'node:fs/promises';
import { delimiter as PATH_DELIM, join } from 'node:path';
import type {
  ProcessRuntime,
  LaunchSpec,
  RuntimeHandle,
  StdioConfig,
} from './types.js';
import { processManager } from '../process-manager/index.js';

// SIGTERM → SIGKILL 的宽限毫秒数；与 process-manager / driver.ts 保持一致。
const KILL_GRACE_MS = 2000;

export class HostRuntime implements ProcessRuntime {
  async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
    if (spec.runtime !== 'host') {
      throw new Error(`HostRuntime cannot handle runtime=${spec.runtime}`);
    }
    const stdio = resolveStdio(spec.stdio);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio,
      detached: true, // F1 PGID 组播前提：子进程自成进程组
    });
    return createHandle(child, spec);
  }

  async isAvailable(cliType: string): Promise<boolean> {
    if (!cliType || cliType.includes('/') || cliType.includes('\\')) return false;
    const path = process.env.PATH ?? '';
    for (const dir of path.split(PATH_DELIM)) {
      if (!dir) continue;
      if (await canExec(join(dir, cliType))) return true;
    }
    return false;
  }

  async destroy(): Promise<void> {
    // host runtime 无资源需释放
  }
}

function resolveStdio(cfg: StdioConfig | undefined): StdioOptions {
  const stdin = cfg?.stdin ?? 'pipe';
  const stdout = cfg?.stdout ?? 'pipe';
  const stderr = cfg?.stderr ?? 'inherit';
  return [stdin, stdout, stderr];
}

function createHandle(child: ChildProcess, spec: LaunchSpec): RuntimeHandle {
  if (child.pid === undefined) {
    throw new Error('child_process.spawn returned no pid');
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

  // 独立 once('exit') 监听：不占用 onExit 单注册槽，内部做 processManager.unregister。
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

  // F2 强制入口：Runtime 自动 register，业务层零改动无法绕过。
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

// F1 PGID 组播：杀进程组把 spawn-helper / node-pty 孙子一起带走。
// EPERM（进程组被抢）/ ESRCH（已退）fallback 到 child.kill。
function killGroup(child: ChildProcess, pid: number, signal: string): void {
  try {
    process.kill(-pid, signal as NodeJS.Signals);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ESRCH') {
      try { child.kill(signal as NodeJS.Signals); } catch { /* already gone */ }
    }
    // 其他错误吞掉（幂等 kill 语义）
  }
}

async function canExec(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function emptyWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({ write() { /* noop */ } });
}

function emptyReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}
