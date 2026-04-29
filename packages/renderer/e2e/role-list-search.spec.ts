// roles 窗口：搜索过滤 / TabFilter 切换 / 搜索无结果空态 E2E。
//
// 红线：零 mock、零 API 绕过 UI、所有入口通过 UI 交互打开。
// 前置：Electron dev 已跑，CDP 9222；主 Agent RUNNING。
//
// 真实 DOM（见 src/pages/RoleListPage.tsx、src/organisms/WorkerListPanel、src/molecules/TabFilter）：
//   .role-list-page__search .input__field           -> 顶部搜索框（受控 value，change 即过滤）
//   .role-list-page__tabs .tab-filter__item         -> 全部 / 模板 / 在线 三 tab
//   .worker-list-panel__cell                         -> 过滤后可见的员工卡片
//   .worker-list-panel__state                        -> 空态容器（有/无员工 + 搜索/无搜索 两版文案）
//   .worker-card__name                               -> 单卡姓名文本
//   .worker-card--online / --idle / --offline       -> 单卡状态 modifier
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, {
    timeout: 2_000,
  });
}

async function ensureCollapsed(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
  }
}

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
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

async function openRolesWindow(browser: Browser, main: Page): Promise<Page> {
  await closeAuxWindows(browser);
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();
  const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
    timeoutMs: 5_000,
  });
  await rolesPage
    .locator('.role-list-page__header')
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });
  return rolesPage;
}

test.describe.configure({ mode: 'serial' });

test.describe('roles 窗口 - 搜索 / 过滤 / 空态', () => {
  let browser: Browser;
  let main: Page;
  let rolesPage: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    // 主 Agent 必须 RUNNING：胶囊按钮 online=false 时 ToolBar 不可操作。
    const logo = main.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(main);
    rolesPage = await openRolesWindow(browser, main);
    // 等首批员工卡渲染。若库里彻底没员工，__cell 不出现是预期的 —— 让 TC-3
    // 独立用搜索制造空态即可。这里短等，拿不到也不 fail。
    await rolesPage
      .locator('.worker-list-panel__cell')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => {});
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    await browser.close();
  });

  // TC-1 搜索过滤：输入 "frontend" → 卡片数减少 + 每张卡片文本包含 "frontend"；清空 → 恢复。
  test('TC-1 搜索过滤：frontend 命中卡片并能恢复', async () => {
    // 前置：确保 tab 在"全部"（避免 TC-2 残留状态）
    const allTab = rolesPage
      .locator('.role-list-page__tabs .tab-filter__item')
      .filter({ hasText: '全部' })
      .first();
    await allTab.locator('.btn').first().click();
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    const searchInput = rolesPage.locator('.role-list-page__search .input__field').first();
    await searchInput.fill('');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 基线：清空搜索时全量卡片数
    const baselineCount = await rolesPage.locator('.worker-list-panel__cell').count();
    expect(baselineCount).toBeGreaterThan(0);

    // 输入搜索词
    await searchInput.fill('frontend');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 命中集 ≥ 1 且严格 < baseline（说明确实过滤了）
    const hitCount = await rolesPage.locator('.worker-list-panel__cell').count();
    expect(hitCount).toBeGreaterThan(0);
    expect(hitCount).toBeLessThan(baselineCount);

    // 可见卡片文本都包含搜索词（大小写不敏感；card 文本含 name/role/desc/mcps）
    const cardTexts = await rolesPage
      .locator('.worker-list-panel__cell')
      .allTextContents();
    for (const t of cardTexts) {
      expect(t.toLowerCase()).toContain('frontend');
    }

    await screenshot(rolesPage, 'role-list-search-tc1-filtered');

    // 清空搜索 → 卡片数恢复到 baseline
    await searchInput.fill('');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);
    await expect
      .poll(async () => rolesPage.locator('.worker-list-panel__cell').count(), {
        timeout: 3_000,
      })
      .toBe(baselineCount);
  });

  // TC-2 TabFilter 切换：在线 tab 只显示 status=online 的成员（可能 0 个）；全部 tab 恢复。
  test('TC-2 TabFilter 切换：在线 tab 只剩在线成员', async () => {
    // 保证搜索框为空，避免上一 case 干扰
    const searchInput = rolesPage.locator('.role-list-page__search .input__field').first();
    await searchInput.fill('');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 点"在线"tab
    const onlineTab = rolesPage
      .locator('.role-list-page__tabs .tab-filter__item')
      .filter({ hasText: '在线' })
      .first();
    await onlineTab.locator('.btn').first().click();
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 可见卡片要么都是 --online，要么 0 张（走 __state 空态）
    const onlineCount = await rolesPage.locator('.worker-list-panel__cell').count();
    if (onlineCount > 0) {
      const nonOnline = await rolesPage
        .locator('.worker-list-panel__cell .worker-card:not(.worker-card--online)')
        .count();
      expect(nonOnline).toBe(0);
    } else {
      // 零员工也是合法路径：此时应出现 __state 文案。无员工总库时是"暂无员工..."，
      // 有员工但全离线时是"没有匹配的员工"。这里只断言有空态容器，不挑文案。
      await expect(rolesPage.locator('.worker-list-panel__state').first()).toBeVisible();
    }
    await screenshot(rolesPage, 'role-list-search-tc2-online-tab');

    // 点"全部"tab → 卡片数恢复
    const allTab = rolesPage
      .locator('.role-list-page__tabs .tab-filter__item')
      .filter({ hasText: '全部' })
      .first();
    await allTab.locator('.btn').first().click();
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    const allCount = await rolesPage.locator('.worker-list-panel__cell').count();
    expect(allCount).toBeGreaterThanOrEqual(onlineCount);
    // "全部" tab 应该命中 active modifier
    await expect(allTab).toHaveClass(/tab-filter__item--active/);
  });

  // TC-3 搜索无结果空态：输入不存在的关键词 → 空态文案"没有匹配的员工"。
  test('TC-3 搜索无结果空态', async () => {
    // 前置：tab 回到"全部"，确保空态不是因为 tab 过滤
    const allTab = rolesPage
      .locator('.role-list-page__tabs .tab-filter__item')
      .filter({ hasText: '全部' })
      .first();
    await allTab.locator('.btn').first().click();
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    const searchInput = rolesPage.locator('.role-list-page__search .input__field').first();
    await searchInput.fill('zzzznotexist999');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 卡片 0 张 + 空态容器可见 + 文案命中
    await expect
      .poll(async () => rolesPage.locator('.worker-list-panel__cell').count(), {
        timeout: 3_000,
      })
      .toBe(0);

    const state = rolesPage.locator('.worker-list-panel__state').first();
    await expect(state).toBeVisible();
    await expect(state).toHaveText(/没有匹配的员工/);

    await screenshot(rolesPage, 'role-list-search-tc3-empty-state');

    // 收尾：清空搜索，把 roles 窗口留给下一 spec 用
    await searchInput.fill('');
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);
  });
});
