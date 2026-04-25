// 以 bun 子进程运行 backend server。Electron main 进程是 Node，
// backend 依赖 bun:sqlite，因此必须隔离运行时。
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// renderer 包下 electron/ → 解析到 packages/backend/src/http/server.ts
const BACKEND_ENTRY = resolve(__dirname, '..', '..', 'backend', 'src', 'http', 'server.ts');

let child: ChildProcess | null = null;

export function startBackend(): ChildProcess {
  if (child && child.exitCode === null) return child;

  child = spawn('bun', ['run', BACKEND_ENTRY], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[electron] backend exited code=${code} signal=${signal}\n`);
    child = null;
  });

  return child;
}

export function stopBackend(): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  child = null;
}
