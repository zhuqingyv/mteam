// Playwright CDP 模式：附到已跑 Electron（9222）+ Playground（5190），不自启 webServer。
// 前置：`bun run start` 已跑起 Vite + Electron；需要测 Playground 时另开 `npm run playground`。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'capsule.spec.ts',
    'expanded.spec.ts',
    'chat.spec.ts',
    'settings.spec.ts',
    'team-panel.spec.ts',
    'playground.spec.ts',
    'phase4-canvas.spec.ts',
    'primary-agent-e2e.spec.ts',
    'primary-agent-states.spec.ts',
    'primary-agent-advanced.spec.ts',
    'team-canvas-extended.spec.ts',
  ],
  timeout: 120_000, // 主 Agent E2E 含三态完整回复 + cancel 闭环，60s 不够，拉到 120s
  expect: { timeout: 5_000 },
  fullyParallel: false, // 所有 spec 共享同一 Electron 实例，串行更稳
  workers: 1, // 多 worker 会并行跑 spec → 同一 Electron 被多个连接抢，必须串行
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 5_000,
  },
  projects: [
    {
      name: 'electron-cdp',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
