// 以 bun 子进程运行 backend server。Electron main 进程是 Node，
// backend 依赖 bun:sqlite，因此必须隔离运行时。
// W2-4 父死子随：spawn 带 detached:true 让子进程独立 PGID；stop 走 -pid 组播 SIGTERM→2s→SIGKILL；
// stdio[0] 保留 pipe，Electron 退出 → stdin EOF → backend 的 watchStdinEnd 触发 shutdown。
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ENTRY = resolve(__dirname, '..', '..', 'backend', 'src', 'http', 'server.ts');
const KILL_GRACE_MS = 2000;
const STOP_WAIT_MS = 4000;

let child: ChildProcess | null = null;

export function startBackend(): ChildProcess {
  if (child && child.exitCode === null) return child;
  child = spawn('bun', ['run', BACKEND_ENTRY], {
    detached: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  child.on('exit', (code, signal) => {
    process.stderr.write(`[electron] backend exited code=${code} signal=${signal}\n`);
    child = null;
  });
  return child;
}

/**
 * 同步触发 SIGTERM → 2s 后 SIGKILL。不等子进程退出（同步调用路径，before-quit 里用）。
 * Electron 关闭 stdin pipe 也会让 backend 的 watchStdinEnd 触发优雅 shutdown。
 */
export function stopBackend(): void {
  if (!child || typeof child.pid !== 'number') return;
  const pid = child.pid;
  child = null;
  const kill = (sig: NodeJS.Signals): void => {
    try { process.kill(-pid, sig); } catch { /* ESRCH / EPERM 静默 */ }
  };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref?.();
}

/**
 * 等子进程真的退出（最多等 STOP_WAIT_MS 毫秒），超时 SIGKILL 进程组再返回。
 * 用在 Electron before-quit 里 preventDefault + 等待，确保 Cmd+Q 不留孤儿。
 */
export async function stopBackendAndWait(): Promise<void> {
  if (!child || typeof child.pid !== 'number') return;
  const c = child;
  const pid = c.pid!;
  child = null;
  const kill = (sig: NodeJS.Signals): void => {
    try { process.kill(-pid, sig); } catch { /* ESRCH / EPERM 静默 */ }
  };
  const exited = new Promise<void>((resolve) => {
    if (c.exitCode !== null || c.signalCode) { resolve(); return; }
    c.once('exit', () => resolve());
  });
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
  await Promise.race([
    exited,
    new Promise<void>((r) => setTimeout(r, STOP_WAIT_MS)),
  ]);
  clearTimeout(timer);
}
