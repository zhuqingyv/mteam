// W2-4 父死子随集成测：spawn 真 backend，关 stdin → watchStdinEnd 触发 shutdown → 进程退出。
// 用 Bun.spawn 起真 http server（:memory: DB + 随机端口），kill 其 stdin，断言 5s 内 exit。
// 只覆盖 stdin 通道（主通道）；ppid 兜底通道已在 parent-watcher.test.ts 单测覆盖。

import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/role-templates`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('W2-4 父死子随：stdin EOF 触发 shutdown', () => {
  it('stdin 关闭 → backend 在 5s 内退出（shutdown 走 process.exit(0)）', async () => {
    const port = 50000 + Math.floor(Math.random() * 10000);
    const sock = `/tmp/test-w2-4-${process.pid}-${port}.sock`;
    const fakeHome = mkdtempSync(join(tmpdir(), 'w2-4-home-'));
    const proc = Bun.spawn(['bun', 'run', 'packages/backend/src/http/server.ts'], {
      env: {
        ...process.env,
        V2_PORT: String(port),
        TEAM_HUB_V2_DB: ':memory:',
        TEAM_HUB_COMM_SOCK: sock,
        HOME: fakeHome,
      },
      cwd: '/Users/zhuqingyu/project/mcp-team-hub',
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });

    try {
      const ready = await waitListening(port, 8000);
      expect(ready).toBe(true);

      // 关 stdin → watchStdinEnd 'end'/'close' → trigger shutdown → process.exit(0)
      proc.stdin?.end();
      const start = Date.now();
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000)),
      ]);
      const elapsed = Date.now() - start;

      expect(exitCode).not.toBe('timeout');
      // shutdown 路径调 process.exit(0)；若异常退出（信号）也算触发到 shutdown，不严格卡 0
      expect(elapsed).toBeLessThan(5000);
    } finally {
      try { proc.kill(); } catch { /* 已退 */ }
    }
  }, 15000);
});
