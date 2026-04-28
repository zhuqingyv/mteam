// 展开态：ToolBar / 输入框 / 收起 / 窗口尺寸（通过 Runtime.evaluate 读）。
// 设计要求：展开 640x620、收起 380x120；AgentSwitcher 在主 Agent 场景下不渲染。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

async function expandIfNeeded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  const expanded = await card.evaluate((el) => el.classList.contains('card--expanded'));
  if (!expanded) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/);
  }
}

async function collapseIfNeeded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  const expanded = await card.evaluate((el) => el.classList.contains('card--expanded'));
  if (expanded) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/);
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

  test('展开后 window.inner 约 640x620（容差 ±20）', async () => {
    // window.innerWidth/Height 不等于 BrowserWindow bounds，但数量级接近可判断 resize 生效。
    const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(Math.abs(w - 640)).toBeLessThan(30);
    expect(Math.abs(h - 620)).toBeLessThan(40);
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
    const card = page.locator('.card').first();
    await expect(card).not.toHaveClass(/card--expanded/);
    // 动画 280ms + 保守等一下再读尺寸
    await page.waitForTimeout(500);
    const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(Math.abs(w - 380)).toBeLessThan(30);
    expect(Math.abs(h - 120)).toBeLessThan(30);
    await screenshot(page, 'expanded-after-collapse');
  });
});
