// 胶囊态（CapsulePage 收起）：Logo / 标题 / 计数 / 点击展开 / MenuDots。
// 前置：Electron 已跑，CDP 9222 可连，主 Agent config.name 通常为 'MTEAM'。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

test.describe('胶囊态', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // 收起态是默认态；若上条测试展开过，点关闭回退。动画 ~550ms，需等锁释放。
  test.beforeEach(async () => {
    const card = page.locator('.card').first();
    // 等动画结束（无 card--animating）再操作
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
    if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
      await page.locator('.card__close .btn').first().click();
      await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
      await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
    }
  });

  test('Logo 可见', async () => {
    const logo = page.locator('.card__logo .logo').first();
    await expect(logo).toBeVisible();
    await screenshot(page, 'capsule-logo');
  });

  test('Logo 状态类名反映 PA 连接状态', async () => {
    const logo = page.locator('.card__logo .logo').first();
    const cls = (await logo.getAttribute('class')) ?? '';
    // online / connecting / offline 三选一；在线时彩色（online）。
    expect(cls).toMatch(/logo--(online|connecting|offline)/);
  });

  test('标题显示 config.name', async () => {
    const title = page.locator('.card__collapsed .text--title').first();
    await expect(title).toBeVisible();
    const t = (await title.textContent())?.trim() ?? '';
    expect(t.length).toBeGreaterThan(0);
  });

  test('Agents / Tasks 计数出现在副标题', async () => {
    const subtitle = page.locator('.card__collapsed .text--subtitle').first();
    await expect(subtitle).toBeVisible();
    const txt = (await subtitle.textContent()) ?? '';
    expect(txt).toMatch(/\d+\s*Agents?\s*·\s*\d+\s*Tasks?/);
  });

  test('点击主体区域展开', async () => {
    const card = page.locator('.card').first();
    // online 才有 onToggle，先读一下 Logo 状态；offline 时跳过
    const logoCls = (await page.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) {
      test.skip(true, 'PA 未在线，胶囊不可展开');
    }
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/);
    await screenshot(page, 'capsule-expanded-after-click');
  });

  test('MenuDots 按钮可点', async () => {
    const dots = page.locator('.card__collapsed .btn--dots').first();
    await expect(dots).toBeVisible();
    // 断言可点（不校验行为，MenuDots 目前只是占位）
    const disabled = await dots.getAttribute('disabled');
    // disabled 属性存在（字符串 "" 也算）表示被禁用
    expect(disabled).toBeNull();
  });
});
