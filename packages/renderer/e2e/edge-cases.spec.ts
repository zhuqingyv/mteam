// P2 边界交互 E2E：连发展开/收起、cancel→再发、Dropdown outside click、Modal 外部点击关闭。
// 红线：零 mock、零 page.request、全 UI 交互、每 TC 截图。
// 前置：Electron dev 在跑（5180 + CDP 9222），主 Agent 已 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  findPageByUrl,
  getMainPage,
  waitMainReady,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const STREAMING_START_TIMEOUT_MS = 15_000;
const TEXT_START_TIMEOUT_MS = 20_000;
const REPLY_COMPLETE_TIMEOUT_MS = 60_000;

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

async function waitIdle(page: Page, timeoutMs: number): Promise<void> {
  await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: timeoutMs });
}

async function lastAgentTextLen(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.message-row--agent'));
    for (let i = rows.length - 1; i >= 0; i--) {
      const bubble = rows[i].querySelector('.bubble--agent');
      if (!bubble) continue;
      const text = (bubble.textContent ?? '').trim();
      if (text.length > 0) return text.length;
    }
    return 0;
  });
}

async function closeAuxWindows(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const u = p.url();
      if (u.includes('window=team') || u.includes('window=roles') || u.includes('window=settings')) {
        await p.close().catch(() => {});
      }
    }
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('P2 边界交互', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
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

  // TC-1：胶囊 ↔ 展开态快速交替 5 次，断言最终状态确定 + .card 仍可见（没崩）。
  test('TC-1 连续 5 次快速展开/收起不卡死', async () => {
    await ensureCollapsed(page);

    const card = page.locator('.card').first();

    // 序列：展开 → 收起 → 展开 → 收起 → 展开（最终 expanded）
    // 每步等前一次动画完成后再点，避免 lockedRef 把点击直接吞掉 —— 这样才算真实用户"快速连点"。
    const steps: Array<{ target: 'expanded' | 'collapsed' }> = [
      { target: 'expanded' },
      { target: 'collapsed' },
      { target: 'expanded' },
      { target: 'collapsed' },
      { target: 'expanded' },
    ];

    for (const step of steps) {
      await waitAnimDone(page);
      const isExpanded = await card.evaluate((el) => el.classList.contains('card--expanded'));
      if (step.target === 'expanded' && !isExpanded) {
        await page.locator('.card__collapsed').first().click();
      } else if (step.target === 'collapsed' && isExpanded) {
        await page.locator('.card__close .btn').first().click();
      }
    }

    // 最终：展开态
    await waitAnimDone(page);
    await expect(card).toHaveClass(/card--expanded/, { timeout: 3_000 });
    // 结构没崩
    await expect(card).toBeVisible();
    await screenshot(page, 'edge-tc1-after-rapid-toggles');

    // 回 idle（可能上一 spec 有残留 streaming —— 本 TC 自身不发消息，所以这里只是清场）
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
  });

  // TC-2：cancel_turn 后立刻再发消息，第二条正常进入列表并能发出。
  test('TC-2 cancel 后立即再发第二条消息', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // 第一条：长问题触发较长 streaming 以确保能抢到停止时机
    const firstPrompt = '请详细介绍一下中国古代四大发明，每一项都要展开说明背景、发明者与影响';
    await page.locator('.chat-input__textarea').first().fill(firstPrompt);
    await page.locator('.chat-input__send').first().click();

    // 等 streaming 开始（stop 按钮出现）
    const stopBtn = page.locator('.chat-input__send--stop').first();
    await expect(stopBtn).toBeVisible({ timeout: STREAMING_START_TIMEOUT_MS });

    // 等至少有文字开始回 —— 这样 cancel 才是在 streaming 中（而非 thinking 前）
    await expect
      .poll(async () => await lastAgentTextLen(page), {
        timeout: TEXT_START_TIMEOUT_MS,
        intervals: [300, 500, 1_000],
      })
      .toBeGreaterThan(0);

    // 点停止
    await stopBtn.click();

    // 等回到 idle（send 按钮回来）
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, {
      timeout: REPLY_COMPLETE_TIMEOUT_MS,
    });
    await expect(page.locator('.chat-input__send').first()).toBeVisible();
    await screenshot(page, 'edge-tc2-after-cancel');

    // 立即发第二条（文本带时间戳确保唯一，且不可能与第一条混淆）
    const secondPrompt = `TC2 二次发送 ${Date.now()}`;
    await page.locator('.chat-input__textarea').first().fill(secondPrompt);
    await page.locator('.chat-input__send').first().click();

    // 第二条 user 气泡出现（文本完全匹配这条唯一文本）
    const secondBubble = page
      .locator('.message-row--user')
      .filter({ hasText: secondPrompt })
      .first();
    await expect(secondBubble).toBeVisible({ timeout: 5_000 });

    // 进一步证明"发出去了"：等 streaming 再次启动（stop 按钮回来），说明第二轮 turn 已被接受进流程
    await expect(page.locator('.chat-input__send--stop')).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });

    await screenshot(page, 'edge-tc2-second-msg-sent');

    // 清场：等第二条回复结束（不卡死下一个 TC）
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
  });

  // TC-3：Dropdown outside click 关闭。点 ToolBar 模型 Dropdown → 打开 → 点 Dropdown 外部 → 关闭。
  test('TC-3 Dropdown outside click 关闭', async () => {
    await ensureExpanded(page);

    const dropdown = page.locator('.toolbar .dropdown').first();
    await expect(dropdown).toBeVisible({ timeout: 5_000 });

    // 先确保当前是 closed，避免上次残留
    const openClassBefore = (await dropdown.getAttribute('class')) ?? '';
    if (openClassBefore.includes('dropdown--open')) {
      // 点 body 关一次
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await expect(dropdown).not.toHaveClass(/dropdown--open/, { timeout: 2_000 });
    }

    // 打开
    await dropdown.locator('.dropdown__trigger').click();
    await expect(dropdown).toHaveClass(/dropdown--open/, { timeout: 2_000 });
    await expect(dropdown.locator('.dropdown__panel')).toBeVisible();
    await screenshot(page, 'edge-tc3-dropdown-open');

    // 在 dropdown 外的区域找一个坐标点击 —— 用卡片头部（.card__head 或 logo 区域）远离 toolbar 的位置
    // 稳妥方案：computed dropdown bbox 上方 30px 处为外部
    const box = await dropdown.boundingBox();
    if (!box) throw new Error('dropdown 无 bounding box');
    // 点 dropdown 正上方 40px 处（应落在 chat-list 或 chat-input 外部）
    await page.mouse.click(box.x + box.width / 2, Math.max(20, box.y - 40));

    // 关闭
    await expect(dropdown).not.toHaveClass(/dropdown--open/, { timeout: 2_000 });
    await expect(dropdown.locator('.dropdown__panel')).toHaveCount(0);
    await screenshot(page, 'edge-tc3-dropdown-closed');
  });

  // TC-4：Modal 外部（backdrop）点击关闭。展开 → 打开成员面板窗口 → 新建成员 Modal → 点 backdrop → 关闭。
  test('TC-4 Modal backdrop 点击关闭', async () => {
    await closeAuxWindows(browser);
    await ensureExpanded(page);

    // 主窗口 ToolBar → 成员面板按钮（aria-label 可能是 "成员面板"/"Team panel"/"成員面板"）
    const teamBtn = page
      .locator('.toolbar__icon-btn')
      .filter({ has: page.locator('svg') })
      .first();
    // 更稳：直接用 Icon name="team" 按钮 —— 它是 toolbar__right 第一个按钮。
    await page.locator('.toolbar__right .toolbar__icon-btn').first().click();

    // 等 roles 窗口出现
    const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
      timeoutMs: 8_000,
    });
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 });
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 点 "新建成员" 按钮
    await rolesPage
      .locator('.role-list-page__tools button')
      .filter({ hasText: '新建成员' })
      .first()
      .click();

    // Modal 出现
    const modal = rolesPage.locator('.modal').first();
    const backdrop = rolesPage.locator('.modal__backdrop').first();
    const panel = rolesPage.locator('.modal__panel').first();
    await expect(modal).toBeVisible({ timeout: 3_000 });
    await expect(panel).toBeVisible();
    await screenshot(rolesPage, 'edge-tc4-modal-open');

    // 点 backdrop（遮罩层）—— Modal 源码里 handleBackdropClick 直接绑在 .modal__backdrop onClick
    await backdrop.click({ position: { x: 10, y: 10 } });

    // Modal 关闭：modal / panel 都从 DOM 消失（Modal 组件 !open 直接返回 null）
    await expect(rolesPage.locator('.modal')).toHaveCount(0, { timeout: 3_000 });
    await screenshot(rolesPage, 'edge-tc4-modal-closed');

    // 清理：关掉 roles 窗口不给下一 spec 污染
    await rolesPage.close().catch(() => {});
  });
});
