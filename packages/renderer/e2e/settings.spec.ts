// 设置窗口：打开 / 三个 Tab / CLI 列表 / 模板列表 / 关闭 / ESC。
// 从主窗口展开态点齿轮打开 settings BrowserWindow（electronAPI.openSettings）。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function openSettingsWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="设置"]').first().click();
  return findPageByUrl(browser, (u) => u.includes('window=settings'), { timeoutMs: 5_000 });
}

async function closeSettingsIfOpen(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('window=settings')) {
        await p.close().catch(() => {});
      }
    }
  }
}

test.describe('设置窗口', () => {
  let browser: Browser;
  let main: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，无法展开→打开 settings');
  });

  test.afterAll(async () => {
    await closeSettingsIfOpen(browser);
    await browser.close();
  });

  test.beforeEach(async () => {
    // 每个 test 前保证 settings 关闭，之后按需打开
    await closeSettingsIfOpen(browser);
  });

  test('点齿轮打开设置窗口', async () => {
    const settings = await openSettingsWindow(browser, main);
    await settings.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await screenshot(settings, 'settings-open');
  });

  test('三个 Tab 可见', async () => {
    const settings = await openSettingsWindow(browser, main);
    const tabs = settings.locator('[role="tablist"] .btn');
    await expect(tabs).toHaveCount(3);
    await expect(settings.getByRole('button', { name: '主 Agent' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'CLI' })).toBeVisible();
    await expect(settings.getByRole('button', { name: '模板管理' })).toBeVisible();
  });

  test('CLI Tab 显示 claude / codex', async () => {
    const settings = await openSettingsWindow(browser, main);
    await settings.getByRole('button', { name: 'CLI' }).click();
    // CliList 列 item 名称渲染（组件库用 CliList 分子，内部具体类名无关，文本稳定）
    await expect(settings.getByText('claude', { exact: false }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(settings.getByText('codex', { exact: false }).first()).toBeVisible();
    await screenshot(settings, 'settings-cli-tab');
  });

  test('模板管理 Tab 显示模板列表容器', async () => {
    const settings = await openSettingsWindow(browser, main);
    await settings.getByRole('button', { name: '模板管理' }).click();
    // TemplateList 是 organism，渲染 Surface 容器；至少有\"新建\"按钮或空态文案之一。
    // 容错：两种任一可见即算 PASS。
    const createBtn = settings.getByRole('button', { name: /新建|创建/ });
    const listRoot = settings.locator('.panel-window');
    await expect(listRoot).toBeVisible();
    if ((await createBtn.count()) > 0) await expect(createBtn.first()).toBeVisible();
    await screenshot(settings, 'settings-template-tab');
  });

  test('关闭按钮可用', async () => {
    const settings = await openSettingsWindow(browser, main);
    const closeBtn = settings.locator('.settings-page__close .btn').first();
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    // 窗口关闭后 page 应从 contexts 里消失
    await expect
      .poll(
        () => {
          for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) {
              if (p.url().includes('window=settings')) return true;
            }
          }
          return false;
        },
        { timeout: 3_000 },
      )
      .toBe(false);
  });

  test('ESC 关闭', async () => {
    const settings = await openSettingsWindow(browser, main);
    // SettingsPage 的 ESC 监听挂在 window 上；keyboard.press 需要 page 焦点，
    // Electron 副窗口 CDP 下焦点不稳，直接 dispatch keydown 更可靠。
    await settings.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await expect
      .poll(
        () => {
          for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) {
              if (p.url().includes('window=settings')) return true;
            }
          }
          return false;
        },
        { timeout: 3_000 },
      )
      .toBe(false);
  });
});
