// P1 胶囊交互 E2E：拖动改位置 / 收起→展开消息保留 / ESC 关展开态。
// 红线：零 mock、零底层 API、全走 Playwright UI（mouse/click/keyboard）。
// 前置：Electron 已跑在 http://localhost:5180/，CDP 9222，主 Agent RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

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
    await page.waitForTimeout(REACT_FLUSH_MS);
  }
}

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('P1 胶囊交互', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 主 Agent 必须 RUNNING，否则胶囊不可点（online=false）。最多等 10s。
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // TC-1 胶囊拖动改位置：mousedown → mousemove 100px → mouseup，窗口位移 > 50px。
  // 注：胶囊占满整个 Electron 窗口，拖动触发 window:start-drag IPC 移动窗口本身。
  // 用 window.screenX/Y 读窗口位置（getBoundingClientRect 反映的是 card 在 viewport 里的偏移，
  // 窗口整体移动时并不变化，但任务要求读一次，作为"card 尺寸稳定"的旁证）。
  test('TC-1 胶囊拖动改位置', async () => {
    await ensureCollapsed(page);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible();

    // 1. 读初始状态：card 的 BCR（viewport 内偏移/尺寸）+ 窗口 screenX/Y（窗口绝对位置）。
    const before = await page.evaluate(() => {
      const el = document.querySelector('.card') as HTMLElement | null;
      const r = el ? el.getBoundingClientRect() : null;
      return {
        bcr: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        screenX: window.screenX,
        screenY: window.screenY,
      };
    });
    expect(before.bcr).not.toBeNull();

    // 2. 在 .card__collapsed 中间 mousedown → 横向 mousemove 100px → mouseup。
    //    Playwright 的 mouse 事件会在 native MouseEvent 上填 screenX=clientX+window.screenX，
    //    useCapsuleDrag 用 e.screenX 触发 startDrag/dragMove IPC，Electron main 把窗口平移过去。
    const box = await page.locator('.card__collapsed').first().boundingBox();
    if (!box) throw new Error('.card__collapsed boundingBox() null');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // 拆成两段 move 确保经过 DRAG_THRESHOLD(5) 且触发 dragMove。
    await page.mouse.move(startX + 30, startY, { steps: 6 });
    await page.mouse.move(startX + 100, startY, { steps: 10 });
    await page.mouse.up();

    // 等窗口移动落位 + React flush。
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 3. 读新位置。
    const after = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
    }));

    // 4. 断言：窗口 screenX 位移 > 50px（放宽 50，任务要求 > 50）。
    const dx = Math.abs(after.screenX - before.screenX);
    expect(dx).toBeGreaterThan(50);

    await screenshot(page, 'p1-tc1-capsule-dragged');
  });

  // TC-2 收起→展开消息保留：展开态发一条带时间戳的消息 → 等 user 气泡出现 →
  // 点 X 收起 → 再次点 .card__collapsed 展开 → 消息还在。
  test('TC-2 收起→展开消息保留', async () => {
    await ensureExpanded(page);

    const marker = `remember-me-${Date.now()}`;
    const card = page.locator('.card').first();

    // 1. 展开态发一条消息。
    await page.locator('.chat-input__textarea').first().fill(marker);
    await page.locator('.chat-input__send').first().click();

    // 2. 等 user 气泡出现（按任务：至少 user 气泡出现即可，不强求 Agent 回复）。
    const userBubble = page.locator('.message-row--user').filter({ hasText: marker }).first();
    await expect(userBubble).toBeVisible({ timeout: 5_000 });

    // 3. 点 X 收起。
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
    await expect(page.locator('.card__collapsed').first()).toBeVisible();

    // 4. 再次点击 .card__collapsed 展开。
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 5. 断言：消息列表里仍有 marker（文本匹配，排除刚发的新消息）。
    const preserved = page.locator('.message-row--user').filter({ hasText: marker });
    await expect(preserved.first()).toBeVisible({ timeout: 5_000 });
    expect(await preserved.count()).toBeGreaterThanOrEqual(1);

    await screenshot(page, 'p1-tc2-message-preserved');
  });

  // TC-3 ESC 键关闭展开态：展开 → Escape → 收起 + 窗口约 380×120。
  test('TC-3 ESC 键关闭展开态', async () => {
    await ensureExpanded(page);
    // 防止 TC-2 可能残留 streaming 态导致 ESC 行为被输入框吞掉 —— 先 blur 输入框。
    await page.locator('body').first().click({ position: { x: 2, y: 2 } }).catch(() => {});
    await page.waitForTimeout(50);

    const card = page.locator('.card').first();
    await expect(card).toHaveClass(/card--expanded/);

    // 按 Escape。
    await page.keyboard.press('Escape');

    // 断言：窗口收起 + 尺寸 ~380×120。
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 3_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 4_000 })
      .toBeLessThan(420);
    const { w, h } = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(Math.abs(w - 380)).toBeLessThan(40);
    expect(Math.abs(h - 120)).toBeLessThan(40);

    await screenshot(page, 'p1-tc3-esc-collapsed');
  });
});
