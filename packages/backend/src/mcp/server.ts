import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readEnv } from './config.js';
import { CommClient } from './comm-client.js';
import { activateSchema, runActivate } from './tools/activate.js';
import { deactivateSchema, runDeactivate } from './tools/deactivate.js';
import { requestOfflineSchema, runRequestOffline } from './tools/request_offline.js';
import { sendMsgSchema, runSendMsg } from './tools/send_msg.js';
import { checkInboxSchema, runCheckInbox } from './tools/check_inbox.js';
import { lookupSchema, runLookup } from './tools/lookup.js';

const TOOL_SCHEMAS = [
  activateSchema,
  deactivateSchema,
  requestOfflineSchema,
  sendMsgSchema,
  checkInboxSchema,
  lookupSchema,
];

function toTextResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const isError =
    data !== null &&
    typeof data === 'object' &&
    'error' in (data as Record<string, unknown>);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export async function runMteamServer(): Promise<void> {
  const env = readEnv();
  const comm = new CommClient(env.commSock, `local:${env.instanceId}`);

  const server = new Server(
    { name: 'mteam', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'activate':
          return toTextResult(await runActivate(env));
        case 'deactivate':
          return toTextResult(await runDeactivate(env));
        case 'request_offline':
          return toTextResult(await runRequestOffline(env, args));
        case 'send_msg':
          return toTextResult(await runSendMsg(env, comm, args));
        case 'check_inbox':
          return toTextResult(await runCheckInbox(env, args));
        case 'lookup':
          return toTextResult(await runLookup(env, args));
        default:
          return toTextResult({ error: `unknown tool: ${name}` });
      }
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
  process.stderr.write(`[mteam] ready instance=${env.instanceId} hub=${env.hubUrl}\n`);
}
