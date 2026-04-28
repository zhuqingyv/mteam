// 展开态：ToolBar / 输入框 / 收起 / 窗口尺寸（通过 Runtime.evaluate 读）。
// 设计要求：展开 640x620、收起 380x120；AgentSwitcher 在主 Agent 场景下不渲染。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, {
    timeout: 2_000,
  });
}

async function expandIfNeeded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
  }
}

async function collapseIfNeeded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
  }
}

test.describe('展开态', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 如果 PA 未在线就无法展开，整个 describe 跳过
    const logoCls = (await page.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，无法展开');
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test.beforeEach(async () => {
    await expandIfNeeded(page);
  });

  test('展开后 window.inner 约 640x620（容差 ±40）', async () => {
    // resize 异步，poll 等 width 进入目标附近再读。
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeGreaterThan(500);
    const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(Math.abs(w - 640)).toBeLessThan(40);
    expect(Math.abs(h - 620)).toBeLessThan(60);
  });

  test('ToolBar 可见（Dropdown + 成员面板 + 齿轮）', async () => {
    await expect(page.locator('.toolbar').first()).toBeVisible();
    await expect(page.locator('.toolbar .dropdown').first()).toBeVisible();
    await expect(page.locator('.toolbar [aria-label="成员面板"]').first()).toBeVisible();
    await expect(page.locator('.toolbar [aria-label="设置"]').first()).toBeVisible();
    await screenshot(page, 'expanded-toolbar');
  });

  test('没有 AgentSwitcher（主 Agent 场景 agents=[]）', async () => {
    await expect(page.locator('.chat-panel__footer .agent-switcher')).toHaveCount(0);
  });

  test('输入框可用', async () => {
    const ta = page.locator('.chat-input__textarea').first();
    await expect(ta).toBeVisible();
    await expect(ta).toBeEnabled();
    await ta.fill('ping');
    await expect(ta).toHaveValue('ping');
    await ta.fill(''); // 清空避免污染下个 test
  });

  test('X 按钮收起 → 窗口约 380x120', async () => {
    await collapseIfNeeded(page);
    // 窗口 resize 是异步（IPC + 动画），poll 等 innerWidth 收到目标值附近
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeLessThan(420);
    const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(Math.abs(w - 380)).toBeLessThan(40);
    expect(Math.abs(h - 120)).toBeLessThan(40);
    await screenshot(page, 'expanded-after-collapse');
  });
});
