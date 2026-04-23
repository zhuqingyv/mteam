// searchTools MCP server 子进程入口：跟 mteam 平级的内置 MCP，由 McpManager.resolve()
// 注入到 --mcp-config 里。agent 调它查询当前角色模板的次屏工具清单。
import { runSearchToolsServer } from './server.js';

runSearchToolsServer().catch((err: unknown) => {
  process.stderr.write(`[searchtools] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
