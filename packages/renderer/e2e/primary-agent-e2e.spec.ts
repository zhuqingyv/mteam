// 主 Agent 全链路 E2E：胶囊展开 → 发消息 → 真实 Agent 回复 → 停止生成 → 收起 → 打开 roles/team。
// 红线：零 mock、零底层 API、所有操作走 Playwright UI 交互（click/fill/keyboard）。
// 前置：Electron 已跑在 http://localhost:5180/，CDP 9222，主 Agent 已 configure 且 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const ANIM_MS = 400; // RESIZE_MS 350 + 余量
const REACT_FLUSH_MS = 200;
const AGENT_REPLY_TIMEOUT_MS = 30_000;

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

test.describe.configure({ mode: 'serial' });

test.describe('主 Agent 全链路', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 主 Agent 必须 RUNNING，否则胶囊不可点（online=false）。最多等 10s 让它启动完成。
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    await browser.close();
  });

  // TC-1 胶囊展开：点 .card__collapsed → .card--expanded + 窗口 ~640x620
  test('TC-1 胶囊展开', async () => {
    await ensureCollapsed(page);
    const card = page.locator('.card').first();
    await expect(card).not.toHaveClass(/card--expanded/);

    // 点胶囊主体区域（不是拖拽区也不是关闭按钮）
    await page.locator('.card__collapsed').first().click();

    // 展开 UI 出现
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 窗口约 640x620（容差 ±40/60）
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeGreaterThan(500);
    const { w, h } = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(Math.abs(w - 640)).toBeLessThan(40);
    expect(Math.abs(h - 620)).toBeLessThan(60);

    await screenshot(page, 'pa-e2e-tc1-expanded');
  });

  // TC-2 发送消息 + 等待真实 Agent 回复：用户气泡 + bubble 文本非空
  test('TC-2 发送消息 + 等待 Agent 回复', async () => {
    await ensureExpanded(page);

    const prompt = '请用一句话介绍你自己';
    const before = await page.locator('.chat-panel__messages .message-row').count();

    await page.locator('.chat-input__textarea').first().fill(prompt);
    await page.locator('.chat-input__send').first().click();

    // 用户消息进入列表
    const userRow = page.locator('.message-row--user').filter({ hasText: prompt }).first();
    await expect(userRow).toBeVisible({ timeout: 3_000 });

    // 等 Agent 真回复：bubble--agent 里出现非空非占位文本。pending-* 只有 typing-dots 没有 text 内容。
    await expect
      .poll(
        async () => {
          // 抓所有 agent 气泡（排除 thinking dots 占位）的文本总和
          return await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.message-row--agent'));
            let combined = '';
            for (const row of rows) {
              // thinking 占位气泡不会有 text block，只有 .typing-dots
              const bubble = row.querySelector('.bubble--agent');
              if (!bubble) continue;
              const text = (bubble.textContent ?? '').trim();
              if (text.length > 0) combined += text;
            }
            return combined;
          });
        },
        { timeout: AGENT_REPLY_TIMEOUT_MS, intervals: [500, 1_000, 2_000] },
      )
      .not.toBe('');

    // 消息数 ≥ 2（用户 + Agent）
    const after = await page.locator('.chat-panel__messages .message-row').count();
    expect(after).toBeGreaterThanOrEqual(before + 2);

    await screenshot(page, 'pa-e2e-tc2-agent-reply');
  });

  // TC-3 停止生成：发长提问 → 等 streaming 态 → 点停止 → 按钮复位
  test('TC-3 停止生成 (cancel_turn)', async () => {
    await ensureExpanded(page);

    // TC-2 的回复可能刚结束；确认输入栏已从 streaming 态回到 send 态
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: 10_000 });

    const prompt = '请详细解释量子计算的原理，越详细越好';
    await page.locator('.chat-input__textarea').first().fill(prompt);
    await page.locator('.chat-input__send').first().click();

    // 等 streaming 态出现（send 按钮变 stop 按钮）
    const stopBtn = page.locator('.chat-input__send--stop').first();
    await expect(stopBtn).toBeVisible({ timeout: 15_000 });
    await screenshot(page, 'pa-e2e-tc3-streaming');

    // 点停止
    await stopBtn.click();

    // 停止按钮消失、恢复成发送按钮
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, {
      timeout: AGENT_REPLY_TIMEOUT_MS,
    });
    // send 按钮重新可见（空输入框下 disabled，但 DOM 存在）
    await expect(page.locator('.chat-input__send').first()).toBeVisible();

    await screenshot(page, 'pa-e2e-tc3-stopped');
  });

  // TC-4 收起胶囊：点关闭按钮 → 胶囊态 + 窗口 ~380x120
  test('TC-4 收起胶囊', async () => {
    await ensureExpanded(page);
    // 等 TC-3 的 streaming 彻底结束再收起，避免请求里
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: 5_000 });

    await page.locator('.card__close .btn').first().click();

    const card = page.locator('.card').first();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 胶囊态 UI 回来
    await expect(page.locator('.card__collapsed').first()).toBeVisible();

    // 窗口约 380x120
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeLessThan(420);
    const { w, h } = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(Math.abs(w - 380)).toBeLessThan(40);
    expect(Math.abs(h - 120)).toBeLessThan(40);

    await screenshot(page, 'pa-e2e-tc4-collapsed');
  });

  // TC-5 打开角色列表：展开 → ToolBar 成员面板按钮 → window=roles 新窗口 + header 可见
  // 注：任务文案说"点成员图标"语义，入口就是 ToolBar 的成员面板按钮（Icon name="team"），aria-label="成员面板"。
  test('TC-5 打开角色列表 (window=roles)', async () => {
    await closeAuxWindows(browser);
    await ensureExpanded(page);

    await page.locator('.toolbar [aria-label="成员面板"]').first().click();

    const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
      timeoutMs: 5_000,
    });
    // header 可见（品牌名 + 搜索框）
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
    await expect(rolesPage.locator('.role-list-page__brand-name').first()).toBeVisible();
    await expect(rolesPage.locator('.role-list-page__search').first()).toBeVisible();

    await screenshot(rolesPage, 'pa-e2e-tc5-roles-window');
  });

  // TC-6 打开团队面板：在 roles 窗口点团队按钮 → window=team 新窗口
  // 任务文案是"点团队图标"，真实路径在 RoleListPage header 右上角（Icon name="team", size=20）。
  test('TC-6 打开团队面板 (window=team)', async () => {
    // roles 窗应该由 TC-5 留下；若没有，重新走一次入口。
    let rolesPage: Page;
    try {
      rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 1_000,
      });
    } catch {
      await ensureExpanded(page);
      await page.locator('.toolbar [aria-label="成员面板"]').first().click();
      rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 5_000,
      });
    }
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });

    // header 右上角 tools 区的团队按钮。Icon name="team" 的 svg 里 path 的 d 以 "M12 12a3.5 3.5"
    // 开头（见 src/atoms/Icon/Icon.tsx SIMPLE.team），用 path 的 d 前缀精确命中这个按钮。
    const teamPathPrefix = 'M12 12a3.5 3.5';
    const teamBtn = rolesPage
      .locator('.role-list-page__tools button')
      .filter({ has: rolesPage.locator(`svg path[d^="${teamPathPrefix}"]`) })
      .first();
    await expect(teamBtn).toBeVisible({ timeout: 3_000 });
    await teamBtn.click();

    const teamPage = await findPageByUrl(browser, (u) => u.includes('window=team'), {
      timeoutMs: 5_000,
    });
    await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    await screenshot(teamPage, 'pa-e2e-tc6-team-window');
  });
});
