// 契约测试：createSearchToolsServer 返回的 Server 能响应 ListTools / CallTool。
// 不 mock fetch —— 用本地临时 HTTP server 承接 /api/mcp-tools/search 回调。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSearchToolsServer } from './server.js';

let hubServer: http.Server;
let hubPort = 0;

beforeAll(async () => {
  hubServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/mcp-tools/search')) {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          hits: [
            { mcpServer: 'demo', toolName: `tool_${q}`, description: `desc ${q}` },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    hubServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = hubServer.address();
  if (typeof addr === 'object' && addr) hubPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => hubServer.close(() => resolve()));
});

async function connectPair(): Promise<Client> {
  const server = createSearchToolsServer({
    instanceId: 'instance-test',
    hubUrl: `http://127.0.0.1:${hubPort}`,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

describe('createSearchToolsServer · ListTools', () => {
  it('exposes a single search tool', async () => {
    const client = await connectPair();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('search');
    await client.close();
  });
});

describe('createSearchToolsServer · CallTool', () => {
  it('search forwards query to hub and returns hits', async () => {
    const client = await connectPair();
    const res = await client.callTool({ name: 'search', arguments: { query: 'foo' } });
    expect(res.isError).toBeUndefined();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].toolName).toBe('tool_foo');
    await client.close();
  });

  it('missing query returns error', async () => {
    const client = await connectPair();
    const res = await client.callTool({ name: 'search', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('unknown tool returns error', async () => {
    const client = await connectPair();
    const res = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
