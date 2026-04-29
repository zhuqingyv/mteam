// 性能基线 E2E：内存 / 首屏 / FPS / WS 连接状态。
// 红线：零 mock。所有指标从真实 Electron 运行时读取。
// 前置：Electron 已跑、CDP 9222 可连，主 Agent 已启动。
//
// 输出策略：所有指标同时通过 console.log 和 test.info().annotations 记录，
// 方便在 CI 报告里抓基线数字做横向对比。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;

type MemorySnapshot = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

// 读 performance.memory（Chromium 专有；Electron 默认启用）。
// 返回字节数，断言时换算 MB。
async function readMemory(page: Page): Promise<MemorySnapshot | null> {
  return await page.evaluate(() => {
    const mem = (performance as unknown as { memory?: MemorySnapshot }).memory;
    if (!mem) return null;
    return {
      usedJSHeapSize: mem.usedJSHeapSize,
      totalJSHeapSize: mem.totalJSHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
    };
  });
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function record(name: string, value: string): void {
  // 写 annotation（HTML/JSON reporter 能抓）+ console.log（list reporter 看得见）
  test.info().annotations.push({ type: 'perf', description: `${name}=${value}` });
  // eslint-disable-next-line no-console
  console.log(`[perf] ${name} = ${value}`);
}

async function ensureCollapsed(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function closeAuxWindows(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const u = p.url();
      if (u.includes('window=team') || u.includes('window=roles')) {
        await p.close().catch(() => {});
      }
    }
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('性能基线', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    await browser.close();
  });

  // TC-1 内存基线：idle 胶囊态 <200MB，展开 + 打开 roles 窗口后 <300MB
  test('TC-1 内存基线 (idle < 200MB, 展开+roles < 300MB)', async () => {
    await ensureCollapsed(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    const idle = await readMemory(page);
    expect(idle, 'performance.memory 必须可用 (Chromium/Electron)').not.toBeNull();
    const idleUsedMB = mb(idle!.usedJSHeapSize);
    const idleTotalMB = mb(idle!.totalJSHeapSize);
    const idleLimitMB = mb(idle!.jsHeapSizeLimit);
    record('tc1.idle.usedJSHeapSize_MB', String(idleUsedMB));
    record('tc1.idle.totalJSHeapSize_MB', String(idleTotalMB));
    record('tc1.idle.jsHeapSizeLimit_MB', String(idleLimitMB));

    expect(idleUsedMB, `idle 主窗口内存 ${idleUsedMB}MB 超过 200MB 基线`).toBeLessThan(200);

    // 展开主窗口 + 打开 roles 窗口，然后再次采样
    await ensureExpanded(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
    await page.locator('.toolbar [aria-label="成员面板"]').first().click();
    const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
      timeoutMs: 5_000,
    });
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForTimeout(REACT_FLUSH_MS);

    const loaded = await readMemory(page);
    expect(loaded).not.toBeNull();
    const loadedUsedMB = mb(loaded!.usedJSHeapSize);
    record('tc1.loaded.usedJSHeapSize_MB', String(loadedUsedMB));

    // roles 窗口独立 renderer 进程，单独采样一份做记录（不做硬断言，只留观察值）
    const rolesMem = await readMemory(rolesPage);
    if (rolesMem) {
      record('tc1.rolesWindow.usedJSHeapSize_MB', String(mb(rolesMem.usedJSHeapSize)));
    }

    expect(
      loadedUsedMB,
      `主窗口展开+打开 roles 后内存 ${loadedUsedMB}MB 超过 300MB 基线`,
    ).toBeLessThan(300);

    await screenshot(page, 'perf-tc1-memory-main');
    await screenshot(rolesPage, 'perf-tc1-memory-roles');

    // 清理：关 roles 窗口、收回主窗口
    await rolesPage.close().catch(() => {});
    await ensureCollapsed(page);
  });

  // TC-2 首屏渲染时间：navigation entry 的 domContentLoadedEventEnd
  // 注：renderer 已经跑了很久，navigation entry 反映的是最初一次加载，仍是有效基线。
  test('TC-2 首屏 DOMContentLoaded < 3000ms', async () => {
    const timing = await page.evaluate(() => {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (navEntries.length === 0) {
        // fallback：用旧 API performance.timing
        const t = performance.timing;
        if (!t || !t.navigationStart) return null;
        return {
          source: 'legacy',
          dcl: t.domContentLoadedEventEnd - t.navigationStart,
          loaded: t.loadEventEnd - t.navigationStart,
        };
      }
      const nav = navEntries[0];
      return {
        source: 'navigation-entry',
        // navigation entry 的时间已经是相对 startTime 的相对时长
        dcl: nav.domContentLoadedEventEnd,
        loaded: nav.loadEventEnd,
      };
    });

    expect(timing, 'navigation timing 必须可用').not.toBeNull();
    record('tc2.source', timing!.source);
    record('tc2.domContentLoadedEventEnd_ms', String(Math.round(timing!.dcl)));
    record('tc2.loadEventEnd_ms', String(Math.round(timing!.loaded)));

    // DOM 加载完成 3 秒内
    expect(
      timing!.dcl,
      `首屏 DOMContentLoaded ${Math.round(timing!.dcl)}ms 超过 3000ms 基线`,
    ).toBeLessThan(3000);
    // loadEventEnd 可能为 0（文档还没 load 完）或正常值；只在有值时做记录，不断言
  });

  // TC-3 FPS 采样：requestAnimationFrame 采样 2s，平均 FPS >= 30
  test('TC-3 FPS 采样 (idle >= 30fps)', async () => {
    await ensureCollapsed(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    const result = await page.evaluate(() => {
      return new Promise<{ frames: number; durationMs: number; fps: number }>((resolveFPS) => {
        const SAMPLE_MS = 2000;
        let frames = 0;
        const start = performance.now();
        const tick = (): void => {
          frames += 1;
          const now = performance.now();
          if (now - start >= SAMPLE_MS) {
            const dur = now - start;
            resolveFPS({ frames, durationMs: dur, fps: (frames / dur) * 1000 });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });

    const fps = Math.round(result.fps * 100) / 100;
    record('tc3.frames', String(result.frames));
    record('tc3.durationMs', String(Math.round(result.durationMs)));
    record('tc3.fps', String(fps));

    expect(fps, `idle FPS ${fps} 低于 30fps 基线`).toBeGreaterThanOrEqual(30);
  });

  // TC-4 WS 连接状态：主 Agent 在线 = WS OPEN。用 Logo 状态类反推。
  // renderer 没暴露 window.__wsLatency；WS 通过 Logo 'online/connecting/offline' 呈现。
  test('TC-4 WS 连接状态 (主 Agent online)', async () => {
    await ensureCollapsed(page);
    const logo = page.locator('.card__logo .logo').first();

    // 等最多 10s 让 logo 类名稳定到 online/connecting/offline 之一
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--(online|connecting|offline)/);

    const cls = (await logo.getAttribute('class')) ?? '';
    const status = cls.includes('logo--online')
      ? 'online'
      : cls.includes('logo--connecting')
        ? 'connecting'
        : 'offline';
    record('tc4.logoStatus', status);

    // 断言：WS 应当是 OPEN（Logo online）。若主 Agent 未配置会是 offline，这种情况明确失败，
    // 因为性能基线前置就是主 Agent RUNNING。
    expect(status, 'WS 未处于 OPEN 状态（主 Agent logo 不在 online）').toBe('online');

    await screenshot(page, 'perf-tc4-ws-status');
  });
});
