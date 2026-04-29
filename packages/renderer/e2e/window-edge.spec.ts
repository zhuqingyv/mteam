// P3 窗口边界 E2E：Logo 三态 / 胶囊与展开尺寸精确 / 极端快速展开收起不卡死。
// 红线：零 mock、零底层 API、全走 Playwright UI（click/keyboard）+ window.innerWidth/Height。
// 前置：Electron dev 在跑（5180 + CDP 9222），主 Agent 已 configure。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

const REACT_FLUSH_MS = 200;

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, {
    timeout: 3_000,
  });
}

async function ensureCollapsed(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 3_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
  }
}

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 3_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('P3 窗口边界', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 本 spec 不强求 Logo=online（TC-1 就是要看三态之一），只需要 .card 已挂载。
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // TC-1：胶囊态 + 展开态 Logo 三态截图，断言 class 落在三态之一。
  //   Logo.css 明确存在 logo--online / logo--connecting / logo--offline 三态。
  //   胶囊 Logo 位于 .card__logo .logo；展开态 Logo 依然由 CapsulePage 渲染在 .card__head 里。
  test('TC-1 胶囊展开后 Logo 三态截图', async () => {
    await ensureCollapsed(page);

    const logoCollapsed = page.locator('.card__logo .logo').first();
    await expect(logoCollapsed).toBeVisible({ timeout: 3_000 });

    const classCollapsed = (await logoCollapsed.getAttribute('class')) ?? '';
    // 胶囊态截图留证（无论三态哪一态）
    await screenshot(page, 'p3-tc1-logo-collapsed');

    // 三态之一
    expect(classCollapsed).toMatch(/logo--(online|connecting|offline)/);

    // 展开态
    await ensureExpanded(page);

    const logoExpanded = page.locator('.card .logo').first();
    await expect(logoExpanded).toBeVisible({ timeout: 3_000 });

    const classExpanded = (await logoExpanded.getAttribute('class')) ?? '';
    await screenshot(page, 'p3-tc1-logo-expanded');

    expect(classExpanded).toMatch(/logo--(online|connecting|offline)/);

    // 收尾：回胶囊态给下个 TC
    await ensureCollapsed(page);
  });

  // TC-2：窗口尺寸精确断言。胶囊 ~380x120（±40），展开 ~640x620（±60/±60）。
  //   读 window.innerWidth/Height（而不是 card boundingBox），因为胶囊/展开对应 Electron 窗口
  //   整体改尺寸（window:resize IPC → BrowserWindow.setBounds），innerWidth/Height 是权威口径。
  test('TC-2 窗口展开/收起尺寸精确', async () => {
    await ensureCollapsed(page);
    // 等窗口 resize 真正落位（Electron IPC + CSS transition）
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeLessThan(500);

    const collapsed = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(Math.abs(collapsed.w - 380)).toBeLessThan(40);
    expect(Math.abs(collapsed.h - 120)).toBeLessThan(40);

    await screenshot(page, 'p3-tc2-collapsed-size');

    await ensureExpanded(page);
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeGreaterThan(500);

    const expanded = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(Math.abs(expanded.w - 640)).toBeLessThan(60);
    expect(Math.abs(expanded.h - 620)).toBeLessThan(60);

    await screenshot(page, 'p3-tc2-expanded-size');

    await ensureCollapsed(page);
  });

  // TC-3：连续 10 次展开/收起（比 P2 TC-1 的 5 次更极端），每次等 animating 消失再点，
  //   最终断言 .card 仍可见、class 落在合法态之一。防止 lockedRef 饥饿 / setState 竞态 / DOM 崩塌。
  test('TC-3 连续快速展开/收起 10 次动画不卡死', async () => {
    await ensureCollapsed(page);

    const card = page.locator('.card').first();

    // 10 次切换：collapsed → expanded → collapsed → ... 最终落在 expanded（第 10 次切出的是 expanded）
    const total = 10;
    for (let i = 0; i < total; i++) {
      await waitAnimDone(page);
      const isExpanded = await card.evaluate((el) => el.classList.contains('card--expanded'));
      if (isExpanded) {
        await page.locator('.card__close .btn').first().click();
      } else {
        await page.locator('.card__collapsed').first().click();
      }
    }

    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    // UI 没崩：.card 仍可见
    await expect(card).toBeVisible();

    // 最终状态合法（expanded / collapsed 二选一，class 要么有 card--expanded 要么有 card__collapsed 子元素）
    const finalIsExpanded = await card.evaluate((el) => el.classList.contains('card--expanded'));
    if (finalIsExpanded) {
      await expect(page.locator('.card__head').first()).toBeVisible();
    } else {
      await expect(page.locator('.card__collapsed').first()).toBeVisible();
    }

    // 交互仍然响应：若当前是展开态，收起一次确认 IPC 路径活着；反之展开一次
    if (finalIsExpanded) {
      await page.locator('.card__close .btn').first().click();
      await expect(card).not.toHaveClass(/card--expanded/, { timeout: 3_000 });
    } else {
      await page.locator('.card__collapsed').first().click();
      await expect(card).toHaveClass(/card--expanded/, { timeout: 3_000 });
    }
    await waitAnimDone(page);

    await screenshot(page, 'p3-tc3-after-10-toggles');
  });
});
