// Playwright e2e 配置：假定前后端已在跑（5174 前端、58580 后端）。
// reuseExistingServer 配合 webServer 保证开发/CI 都能用；本地已跑就直接复用。
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filenameESM = fileURLToPath(import.meta.url);
const __dirnameESM = dirname(__filenameESM);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // 操作共享数据（templates/roster），串行更稳
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    // 所有测试后输出到 stdout 的 console 错误便于定位
    actionTimeout: 5_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // 后端：若 58580 已在跑，直接复用；否则尝试启动
      command:
        'bun --watch ../backend/src/server.ts',
      url: 'http://localhost:58580/api/role-templates',
      reuseExistingServer: true,
      timeout: 15_000,
      cwd: __dirnameESM,
    },
    {
      // 前端 Vite dev server
      command: 'bun run dev',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 15_000,
      cwd: __dirnameESM,
    },
  ],
});
