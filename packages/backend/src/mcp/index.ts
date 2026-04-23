// mteam MCP server 子进程入口：由 pty manager 通过 claude CLI 注册后拉起
import { runMteamServer } from './server.js';

runMteamServer().catch((err: unknown) => {
  process.stderr.write(`[mteam] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
