// mteam MCP server 子进程入口：由 AgentDriver 通过 CLI 注册后拉起
import { runMteamServerStdio } from './server.js';

runMteamServerStdio().catch((err: unknown) => {
  process.stderr.write(`[mteam] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
