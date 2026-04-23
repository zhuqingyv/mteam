import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readEnv } from './config.js';
import { CommClient } from './comm-client.js';
import { findTool, visibleTools, type ToolDeps } from './tools/registry.js';

function toTextResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const isError =
    data !== null &&
    typeof data === 'object' &&
    'error' in (data as Record<string, unknown>);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function connectCommWithRetry(comm: CommClient, address: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await comm.ensureReady();
      process.stderr.write(`[mteam] comm ready address=${address} attempt=${attempt}\n`);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      process.stderr.write(`[mteam] comm connect failed attempt=${attempt}/${MAX_ATTEMPTS} err=${msg}\n`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
  }
  process.stderr.write(`[mteam] comm connect gave up address=${address} — send_msg will retry on demand\n`);
}

export async function runMteamServer(): Promise<void> {
  const env = readEnv();
  const selfAddress = `local:${env.instanceId}`;
  const comm = new CommClient(env.commSock, selfAddress);
  await connectCommWithRetry(comm, selfAddress);
  const deps: ToolDeps = { env, comm };

  const server = new Server(
    { name: 'mteam', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(env.isLeader).map((t) => t.schema),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const entry = findTool(name);
    if (!entry) {
      return toTextResult({ error: `unknown tool: ${name}` });
    }
    if (entry.leaderOnly && !env.isLeader) {
      return toTextResult({ error: `tool '${name}' is leader-only` });
    }
    try {
      return toTextResult(await entry.handler(deps, args));
    } catch (e) {
      return toTextResult({ error: (e as Error).message });
    }
  });

  const cleanup = (): void => {
    try { comm.close(); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.stdin.on('close', () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 启动就绪日志标签保留 [mteam]，与 pty manager 日志前缀对齐
  process.stderr.write(`[mteam] ready instance=${env.instanceId} hub=${env.hubUrl} leader=${env.isLeader ? 1 : 0}\n`);
}
