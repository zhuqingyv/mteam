import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// panel.html 位置：源码走 src/panel.html（相对本文件 ../panel.html）；
// build 后若与入口同目录也尝试 ./panel.html。两处都找不到才 500。
const PANEL_HTML_CANDIDATES = [join(HERE, '..', 'panel.html'), join(HERE, 'panel.html')];

// 启动缓存：panel.html 是静态资源，进程生命周期内不变。
// 首次成功读取后缓存，后续请求直接复用 Buffer，省去每次 syscall。
let cached: Buffer | null = null;

export function servePanelHtml(res: http.ServerResponse): void {
  if (cached) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': cached.byteLength,
    });
    res.end(cached);
    return;
  }
  for (const p of PANEL_HTML_CANDIDATES) {
    try {
      const html = readFileSync(p);
      cached = html;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.byteLength,
      });
      res.end(html);
      return;
    } catch {
      /* try next candidate */
    }
  }
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('panel.html not found');
}
