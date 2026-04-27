// 单实例启动守卫：端口占用或存活 pid 文件 → stderr 清晰报错 + process.exit(1)。
// 用户要求：错误信息要让开发 agent 一眼知道是谁占了端口、怎么解决。
// 两道检测：
//   1) checkPidFile  — 启动最前同步检测 pid 文件（存活则直接拒绝，stale 则清理）。
//   2) attachPortGuard — 给 http.Server 挂 error 监听；EADDRINUSE 打清晰错误后 exit。
// 保持 startServer 同步：pid 检查同步，端口检查借 server.listen 的 error 事件。
import fs from 'node:fs';
import type http from 'node:http';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_PID_PATH =
  process.env.TEAM_HUB_BACKEND_PID ||
  join(homedir(), '.claude', 'team-hub', 'backend.pid');

export interface GuardDeps {
  pidPath?: string;
  exit?: (code: number) => never;
  stderr?: (msg: string) => void;
  isAlive?: (pid: number) => boolean;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH=不存在；EPERM=存在但无权限（仍算存活）。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function fatal(write: (m: string) => void, exit: (c: number) => never, port: number, reason: string, pid: number | null): never {
  write(`[v2] FATAL: ${reason}\n`);
  if (pid !== null) {
    write(`[v2] Another backend instance is running (pid=${pid}).\n`);
    write(`[v2] Kill it with: kill ${pid}\n`);
  }
  write(`[v2] Or use a different port: V2_PORT=${port + 1} bun run dev\n`);
  return exit(1);
}

// 同步 pid 文件检测：存活进程 → 立刻报错退出；stale → 清理后返回。
export function checkPidFile(port: number, deps: GuardDeps = {}): void {
  const pidPath = deps.pidPath ?? DEFAULT_PID_PATH;
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const write = deps.stderr ?? ((m: string) => { process.stderr.write(m); });
  const isAlive = deps.isAlive ?? defaultIsAlive;

  if (!fs.existsSync(pidPath)) return;
  const raw = (() => { try { return fs.readFileSync(pidPath, 'utf8').trim(); } catch { return ''; } })();
  const oldPid = Number.parseInt(raw, 10);
  if (Number.isFinite(oldPid) && oldPid > 0 && isAlive(oldPid)) {
    fatal(write, exit, port, `backend already running on port ${port}.`, oldPid);
  }
  try { fs.unlinkSync(pidPath); } catch { /* 竞态删除忽略 */ }
}

// 给 http.Server 挂端口错误监听：EADDRINUSE → 清晰报错 + exit。
// 注意：成功 listen 后仍保留 error 监听（运行时再出错仍走 fatal），但清除监听的选项留给调用方 shutdown。
export function attachPortGuard(server: http.Server, port: number, deps: GuardDeps = {}): void {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const write = deps.stderr ?? ((m: string) => { process.stderr.write(m); });
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      fatal(write, exit, port, `port ${port} already in use.`, null);
      return;
    }
    fatal(write, exit, port, `listen failed on port ${port}: ${err.message}.`, null);
  });
}

export function writePidFile(pidPath: string = DEFAULT_PID_PATH): void {
  try {
    fs.mkdirSync(dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  } catch (err) {
    process.stderr.write(`[v2] warn: failed to write pid file: ${(err as Error).message}\n`);
  }
}

export function removePidFile(pidPath: string = DEFAULT_PID_PATH): void {
  try { fs.unlinkSync(pidPath); } catch { /* 已删除或不存在都忽略 */ }
}
