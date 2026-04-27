import type http from 'node:http';
import type { ApiResponse } from '../api/panel/role-templates.js';

// 现有 POST 最大 payload 是 role-template config / mcp install（<<1MB），
// 留 1MB 封顶足够且能挡恶意大包。抛 BodyTooLargeError，由 router 捕获后返回 413。
const MAX_BODY_BYTES = 1 << 20;

export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0; // 丢掉已收内容；继续 drain 等 end 再 reject 以便 server 能回 413。
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new BodyTooLargeError(MAX_BODY_BYTES));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// CORS 公共头：允许本地开发面板（Vite 5174 等）跨域调用 backend。
// 前端浏览器跨域会先发预检（OPTIONS），若缺失这些头会直接失败。
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type,X-Role-Instance-Id,X-Requested-With,Authorization',
  'Access-Control-Max-Age': '600',
};

export function jsonResponse(res: http.ServerResponse, resp: ApiResponse): void {
  if (resp.status === 204) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const body = JSON.stringify(resp.body);
  res.writeHead(resp.status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export const notFound: ApiResponse = { status: 404, body: { error: 'not found' } };
