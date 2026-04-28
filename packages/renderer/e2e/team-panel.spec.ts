// Team Panel：点成员面板打开 → 空态"尚未创建团队" → 画布可见。
// 打开路径：主窗口 expanded → ToolBar 成员面板按钮 → TeamPage 独立窗。
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

async function openTeamWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();
  return findPageByUrl(browser, (u) => u.includes('window=team'), { timeoutMs: 5_000 });
}

async function closeTeamIfOpen(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('window=team')) await p.close().catch(() => {});
    }
  }
}

test.describe('Team Panel', () => {
  let browser: Browser;
  let main: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线');
  });

  test.afterAll(async () => {
    await closeTeamIfOpen(browser);
    await browser.close();
  });

  test.beforeEach(async () => {
    await closeTeamIfOpen(browser);
  });

  test('点成员面板按钮打开', async () => {
    const team = await openTeamWindow(browser, main);
    await team.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await screenshot(team, 'team-panel-open');
  });

  test('无团队时显示空态文案', async () => {
    const team = await openTeamWindow(browser, main);
    // 空态或画布二选一：有 team 则 TeamMonitorPanel，无 team 则 team-page__empty
    const empty = team.locator('.team-page__empty');
    const canvas = team.locator('.panel-window');
    // 画布根一定可见；若无 team，应看到"尚未创建团队"
    await expect(canvas).toBeVisible();
    if ((await empty.count()) > 0) {
      await expect(team.getByText('尚未创建团队')).toBeVisible();
      await expect(team.getByRole('button', { name: '创建团队' })).toBeVisible();
    }
  });

  test('画布容器可见（panel-window 根）', async () => {
    const team = await openTeamWindow(browser, main);
    await expect(team.locator('.panel-window')).toBeVisible();
  });
});
