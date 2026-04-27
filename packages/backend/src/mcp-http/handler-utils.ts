// mcp-http handler 共用小工具：body 读取、JSON 错误响应、session map。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  close: () => void;
}

export type SessionMap = Map<string, SessionEntry>;

export function sessions(): SessionMap {
  return new Map();
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const body = {
    jsonrpc: '2.0' as const,
    error: { code: -32000, message },
    id: null as null,
  };
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function closeAll(map: SessionMap): void {
  for (const entry of map.values()) {
    try { entry.close(); } catch { /* ignore */ }
    void entry.transport.close();
  }
  map.clear();
}
