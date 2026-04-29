// 副窗口生命周期 + 状态持久化 E2E。
// 场景：
//   TC-1 roles 窗口开/关/重开，成员数一致
//   TC-2 settings 窗口开/关/重开（含 CLI tab 切换）
//   TC-3 canvas pan/zoom 跨 team 切换保留（如没有 team 窗口或只有 1 个 team 则 skip）
//
// 零 mock / 零 API 绕过 UI：所有操作都由主窗口 UI 触发。
// 仅在 TC-3 前通过 ENV 可配置的 backend 地址读取 /api/teams 判定 team 数量（read-only 判定，不改状态）。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const BACKEND_URL = process.env.MTEAM_BACKEND_URL ?? 'http://127.0.0.1:58590';

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function findPanel(
  browser: Browser,
  key: 'roles' | 'settings' | 'team',
  timeoutMs = 5_000,
): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes(`window=${key}`), { timeoutMs });
}

async function closePanelIfOpen(
  browser: Browser,
  key: 'roles' | 'settings' | 'team',
): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(`window=${key}`)) await p.close().catch(() => {});
    }
  }
}

// 展开态顶层工具栏，"成员面板"按钮走 electronAPI.openRoleList → window=roles。
async function openRolesWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();
  return findPanel(browser, 'roles');
}

async function openSettingsWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="设置"]').first().click();
  return findPanel(browser, 'settings');
}

async function isPanelStillOpen(
  browser: Browser,
  key: 'roles' | 'settings' | 'team',
): Promise<boolean> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(`window=${key}`)) return true;
    }
  }
  return false;
}

test.describe('副窗口生命周期 + 状态持久化', () => {
  let browser: Browser;
  let main: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    const logoCls =
      (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，无法展开→打开副窗口');
  });

  test.afterAll(async () => {
    await closePanelIfOpen(browser, 'roles');
    await closePanelIfOpen(browser, 'settings');
    await browser.close();
  });

  // ─── TC-1 roles 窗口开/关/重开，成员数一致 ─────────────────────────────
  test('TC-1 roles 窗口开/关/重开，成员数一致', async () => {
    await closePanelIfOpen(browser, 'roles');

    // 首次打开
    const roles1 = await openRolesWindow(browser, main);
    await roles1.locator('.role-list-page').first().waitFor({ state: 'visible', timeout: 5_000 });
    // 等卡片列表渲染（空态时 count=0 亦可；这里只做稳定等待）
    await roles1.waitForTimeout(300);
    const count1 = await roles1.locator('.worker-card').count();
    await screenshot(roles1, 'panel-lifecycle-tc1-open1');

    // 关闭（点 header close 按钮）
    await roles1
      .locator('.role-list-page__tools .btn')
      .last()
      .click();
    await expect
      .poll(() => isPanelStillOpen(browser, 'roles'), { timeout: 3_000 })
      .toBe(false);

    // 再次打开（主窗口 ToolBar 成员面板按钮）
    const roles2 = await openRolesWindow(browser, main);
    await roles2.locator('.role-list-page').first().waitFor({ state: 'visible', timeout: 5_000 });
    await roles2.waitForTimeout(300);
    const count2 = await roles2.locator('.worker-card').count();
    await screenshot(roles2, 'panel-lifecycle-tc1-open2');

    expect(count2).toBe(count1);

    await closePanelIfOpen(browser, 'roles');
  });

  // ─── TC-2 settings 窗口开/关/重开 ───────────────────────────────────────
  test('TC-2 settings 窗口开/关/重开', async () => {
    await closePanelIfOpen(browser, 'settings');

    // 首次打开 → 默认 tab（主 Agent）
    const s1 = await openSettingsWindow(browser, main);
    await s1.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await screenshot(s1, 'panel-lifecycle-tc2-open1');

    // 切到 CLI tab
    await s1.getByRole('button', { name: 'CLI' }).click();
    // CLI tab 内容稳定出现（claude/codex 任一命中即可）
    await expect(s1.getByText(/claude|codex/i).first()).toBeVisible({ timeout: 5_000 });
    await screenshot(s1, 'panel-lifecycle-tc2-cli-tab');

    // 关闭窗口（点右上 close）
    await s1.locator('.settings-page__close .btn').first().click();
    await expect
      .poll(() => isPanelStillOpen(browser, 'settings'), { timeout: 3_000 })
      .toBe(false);

    // 重新打开
    const s2 = await openSettingsWindow(browser, main);
    await s2.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    // SettingsPage 使用内部 useState('primary')，没有 tab 记忆 → 断言回到默认 tab
    // 默认 tab 是"主 Agent" → 其专属容器 .pa-settings 可见。
    // 这是当前设计的正确行为，防止将来误加 tab 持久化却没同步更新测试。
    const primaryPanel = s2.locator('.pa-settings');
    await expect(primaryPanel).toBeVisible({ timeout: 3_000 });
    await screenshot(s2, 'panel-lifecycle-tc2-open2-default-tab');

    await closePanelIfOpen(browser, 'settings');
  });

  // ─── TC-3 canvas pan/zoom 跨 team 切换保留 ──────────────────────────────
  test('TC-3 canvas pan/zoom 跨 team 切换保留', async () => {
    // 前置：team 窗口已开 + teams.length >= 2 才测。否则 skip。
    const teamAlreadyOpen = await isPanelStillOpen(browser, 'team');
    if (!teamAlreadyOpen) {
      test.skip(true, 'team 窗口未打开，按任务要求跳过 TC-3');
      return;
    }

    const team = await findPanel(browser, 'team');
    await team.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    // 读 sidebar 条目 count 判断是否够 2 个 team
    const items = team.locator('.tsb__list .tsi');
    const teamCount = await items.count();
    if (teamCount < 2) {
      test.skip(true, `只有 ${teamCount} 个 team，跨 team 切换无法测试`);
      return;
    }

    // 触发 wheel 将 zoom 缩到约 75%（factor = exp(-deltaY * 0.0015)；deltaY=~192 → ≈0.75）
    const canvas = team.locator('.canvas-viewport, .team-canvas, .team-monitor__body').first();
    await canvas.waitFor({ state: 'visible', timeout: 3_000 });

    async function readZoomPercent(): Promise<number> {
      const txt = await team.locator('.canvas-top-bar__zoom-text').first().textContent();
      return Number((txt ?? '').replace('%', '').trim());
    }

    const zoomBefore = await readZoomPercent();
    // 不断滚动缩小，直到 zoomPercent 落到 70~80 之间（容错 75±5）。
    // 滚轮 handler 内部 200ms debounce commit，每次 wheel 后等 300ms 再读。
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas boundingBox null');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    let current = zoomBefore;
    for (let i = 0; i < 20 && (current > 80 || current < 70); i++) {
      await team.mouse.move(cx, cy);
      if (current > 80) {
        // 缩小（deltaY>0 → factor<1）
        await team.mouse.wheel(0, 60);
      } else {
        await team.mouse.wheel(0, -60);
      }
      await team.waitForTimeout(320);
      current = await readZoomPercent();
    }
    const zoomAtTeamA = current;
    expect(zoomAtTeamA).toBeGreaterThanOrEqual(70);
    expect(zoomAtTeamA).toBeLessThanOrEqual(80);
    await screenshot(team, 'panel-lifecycle-tc3-teamA-75');

    // 记录当前 active team id，切到另一个 team 再切回来
    const activeIdx = await items.evaluateAll((els) =>
      els.findIndex((el) => el.classList.contains('tsi--active')),
    );
    const otherIdx = activeIdx === 0 ? 1 : 0;

    await items.nth(otherIdx).click();
    await team.waitForTimeout(400);
    await screenshot(team, 'panel-lifecycle-tc3-teamB');

    // 切回原 team
    await items.nth(activeIdx).click();
    await team.waitForTimeout(400);

    const zoomAfter = await readZoomPercent();
    expect(zoomAfter).toBe(zoomAtTeamA);
    await screenshot(team, 'panel-lifecycle-tc3-teamA-restored');
  });
});
