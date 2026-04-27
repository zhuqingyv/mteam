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
