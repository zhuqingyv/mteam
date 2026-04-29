// 主 Agent 三态 UI + cancel_turn 完整闭环 E2E。
// 红线：零 mock、零 page.request、全 UI 交互、Agent 真实推理、每 TC 截图。
// 前置：Electron dev 已跑 http://localhost:5180/ + CDP 9222，主 Agent 已 configure 且 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

const ANIM_SETTLE_MS = 400;
const REACT_FLUSH_MS = 200;
const STREAMING_START_TIMEOUT_MS = 15_000; // 等 stop 按钮出现
const TEXT_START_TIMEOUT_MS = 20_000; // 等回复开始出现文字
const REPLY_COMPLETE_TIMEOUT_MS = 60_000; // 回复完成（idle）
const STABILITY_WINDOW_MS = 3_000; // 取消后 3s 文字长度稳定

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, {
    timeout: 2_000,
  });
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

// 等输入框回到 idle（没有 stop 按钮），避免上一条消息残留 streaming 干扰。
async function waitIdle(page: Page, timeoutMs: number): Promise<void> {
  await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: timeoutMs });
}

// 统计最后一条 agent 气泡（非 thinking 占位）里 text block 的累计字符数。
// pending-*/thinking 气泡没有 text block，会返回 0，这是\"是否开始 responding\"的判据。
async function lastAgentTextLen(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.message-row--agent'));
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const bubble = row.querySelector('.bubble--agent');
      if (!bubble) continue;
      const text = (bubble.textContent ?? '').trim();
      if (text.length > 0) return text.length;
    }
    return 0;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('主 Agent 三态 UI + cancel 闭环', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 主 Agent 必须 RUNNING，Logo 才能是 online（胶囊和展开态都共用 .logo）。
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureExpanded(page);
    // 确保从 idle 开始：可能有上一个 spec 残留的 streaming
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // TC-B9: 胶囊态 Logo online + 展开态发消息后经过 thinking → responding → idle 三态，都截图留证。
  test('TC-B9 primary_agent 三态 UI (idle → thinking → responding → idle)', async () => {
    // Step 1: 胶囊态 Logo online 断言。先收起成胶囊，拍 Logo。
    const card = page.locator('.card').first();
    if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
      await page.locator('.card__close .btn').first().click();
      await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
      await waitAnimDone(page);
      await page.waitForTimeout(REACT_FLUSH_MS);
    }
    const capsuleLogo = page.locator('.card__logo .logo').first();
    await expect(capsuleLogo).toHaveClass(/logo--online/);
    await screenshot(page, 'b9-1-idle-capsule-online');

    // Step 2: 展开 → 发一条消息
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const prompt = '你好，请用一句话介绍你自己';
    await page.locator('.chat-input__textarea').first().fill(prompt);
    await screenshot(page, 'b9-2-idle-expanded-before-send');
    await page.locator('.chat-input__send').first().click();

    // 用户气泡进列表（证明发送成功）
    const userRow = page.locator('.message-row--user').filter({ hasText: prompt }).first();
    await expect(userRow).toBeVisible({ timeout: 3_000 });

    // Step 3: thinking 态 —— stop 按钮出现 + .typing-dots 可见
    await expect(page.locator('.chat-input__send--stop')).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });
    // thinking 态的标记：agent 侧出现 typing-dots（pending-* 占位 或 block.type==='thinking'）
    await expect(page.locator('.typing-dots').first()).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });
    await screenshot(page, 'b9-3-thinking');

    // Step 4: responding 态 —— 回复文本开始出现
    await expect
      .poll(async () => await lastAgentTextLen(page), {
        timeout: TEXT_START_TIMEOUT_MS,
        intervals: [300, 500, 1_000],
      })
      .toBeGreaterThan(0);
    // 此时 stop 按钮仍在（还没 completed）—— 验证是\"正在回复\"而不是\"已完成\"。
    await expect(page.locator('.chat-input__send--stop')).toBeVisible();
    await screenshot(page, 'b9-4-responding');

    // Step 5: 回到 idle —— stop 按钮消失 + send 按钮 DOM 可见
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
    await expect(page.locator('.chat-input__send').first()).toBeVisible();
    // 最终 agent 气泡仍然保留有文字
    const finalLen = await lastAgentTextLen(page);
    expect(finalLen).toBeGreaterThan(0);
    await screenshot(page, 'b9-5-idle-after-reply');

    // Step 6: Logo 回到 online（RUNNING 状态不变）
    const logo = page.locator('.card__logo .logo').first();
    await expect(logo).toHaveClass(/logo--online/);
  });

  // TC-B7: cancel_turn 完整闭环 —— 发长提问 → streaming → 点停止 → 按钮复位 + 文字不再增长。
  test('TC-B7 cancel_turn 完整闭环 (含 streaming 结束断言)', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const prompt = '请逐一解释 SOLID 五大原则，每个原则给出三个代码例子';
    await page.locator('.chat-input__textarea').first().fill(prompt);
    await page.locator('.chat-input__send').first().click();

    // Step 1: streaming 开始（stop 按钮出现）
    const stopBtn = page.locator('.chat-input__send--stop').first();
    await expect(stopBtn).toBeVisible({ timeout: STREAMING_START_TIMEOUT_MS });

    // Step 2: 等至少一些文字出现在 agent 气泡里 —— 进入 responding 态（不是 thinking 态）
    await expect
      .poll(async () => await lastAgentTextLen(page), {
        timeout: TEXT_START_TIMEOUT_MS,
        intervals: [300, 500, 1_000],
      })
      .toBeGreaterThan(0);

    // 记下取消前的文字长度，用于之后对比
    const lenAtCancel = await lastAgentTextLen(page);
    expect(lenAtCancel).toBeGreaterThan(0);

    // Step 3: 点停止
    await stopBtn.click();

    // Step 4: stop 按钮消失 + 变回 send 按钮
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, {
      timeout: REPLY_COMPLETE_TIMEOUT_MS,
    });
    await expect(page.locator('.chat-input__send').first()).toBeVisible();
    // 确认\"不是 stop 模式\"—— 当前 send 按钮不带 --stop class
    const sendBtnClass = (await page.locator('.chat-input__send').first().getAttribute('class')) ?? '';
    expect(sendBtnClass).not.toMatch(/chat-input__send--stop/);

    // Step 5: agent 气泡里有部分回复文字（不为空）—— 证明确实在 streaming 时被打断
    const lenAfterStop = await lastAgentTextLen(page);
    expect(lenAfterStop).toBeGreaterThan(0);

    // Step 6: 等 3s 后文字长度不变（不再 streaming）
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    const lenStable = await lastAgentTextLen(page);
    expect(lenStable).toBe(lenAfterStop);

    // Step 7: 截图留证
    await screenshot(page, 'b7-cancelled-stable');
  });
});
