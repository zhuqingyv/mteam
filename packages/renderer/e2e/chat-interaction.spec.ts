// 聊天交互细节 E2E：自动滚底 / Shift+Enter 换行 / 空输入不发送。
// 红线：零 mock、零底层 API，全部通过 Playwright UI 交互（click/fill/键盘）完成。
// 前置：Electron dev 已跑在 http://localhost:5180/，CDP 9222，主 Agent 已 configure 且 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const USER_BUBBLE_TIMEOUT_MS = 5_000;

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
  await page.waitForTimeout(REACT_FLUSH_MS);
}

// 读 VirtualList 内部真正的滚动容器（不是 .chat-panel__messages 外层，而是里面的 .virtual-list）。
async function readScroll(page: Page): Promise<{ top: number; client: number; scroll: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.chat-panel__messages .virtual-list') as HTMLElement | null;
    if (!el) return { top: -1, client: -1, scroll: -1 };
    return { top: el.scrollTop, client: el.clientHeight, scroll: el.scrollHeight };
  });
}

async function countUserBubbles(page: Page): Promise<number> {
  return page.locator('.chat-panel__messages .message-row--user').count();
}

test.describe.configure({ mode: 'serial' });

test.describe('聊天交互细节', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // 主 Agent 必须 RUNNING，否则 sendUserPrompt 在 resolveIid 拿不到 instanceId 会走兜底不真发。
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // TC-1 聊天列表自动滚到底：展开态连发 3 条，每条都等 user 气泡出现再发下一条。
  // 最后读 VirtualList 的 scrollTop+clientHeight 是否贴近 scrollHeight（容差 50px）。
  test('TC-1 聊天列表自动滚到底', async () => {
    await ensureExpanded(page);

    const textarea = page.locator('.chat-input__textarea').first();
    const prompts = ['msg1', 'msg2', 'msg3'];

    const before = await countUserBubbles(page);

    for (let i = 0; i < prompts.length; i++) {
      const text = prompts[i];
      await textarea.fill(text);
      // 用 Enter 发送（ChatInput onKeyDown 内已 preventDefault，走 onSend → sendUserPrompt）。
      await textarea.press('Enter');

      // 等这条 user 气泡出现后再发下一条 —— 用 count >= before + i + 1 判定。
      const target = before + i + 1;
      await expect
        .poll(async () => countUserBubbles(page), {
          timeout: USER_BUBBLE_TIMEOUT_MS,
          intervals: [100, 200, 400],
        })
        .toBeGreaterThanOrEqual(target);
    }

    // 等 VirtualList useEffect 在 items 变化后执行 scrollTop = scrollHeight（要下一帧 + 等待 measure）。
    await page.waitForTimeout(REACT_FLUSH_MS);

    const { top, client, scroll } = await readScroll(page);
    expect(scroll).toBeGreaterThan(0);
    // 自动滚底判据：scrollTop + clientHeight 与 scrollHeight 差值 ≤ 50px。
    expect(scroll - (top + client)).toBeLessThanOrEqual(50);

    await screenshot(page, 'chat-interaction-tc1-autoscroll');
  });

  // TC-2 Shift+Enter 换行 vs Enter 发送：同一输入框里按 Shift+Enter 得 "\n"，随后 Enter 清空并出现多行气泡。
  test('TC-2 Shift+Enter 换行 vs Enter 发送', async () => {
    await ensureExpanded(page);
    const textarea = page.locator('.chat-input__textarea').first();

    await textarea.fill('');
    await textarea.focus();
    await textarea.type('第一行');
    await textarea.press('Shift+Enter');
    await textarea.type('第二行');

    // 断言 textarea value 带换行 —— 用 DOM value 属性读，避免 inputValue() 把 \n 规范化。
    const valWithNewline = await textarea.evaluate((el) => (el as HTMLTextAreaElement).value);
    expect(valWithNewline).toContain('\n');
    expect(valWithNewline).toContain('第一行');
    expect(valWithNewline).toContain('第二行');

    const beforeCount = await countUserBubbles(page);

    // 不带 Shift 的 Enter → 发送。
    await textarea.press('Enter');

    // 输入框清空（onChange 会被触发，上层清空 inputValue）。
    await expect
      .poll(async () => textarea.evaluate((el) => (el as HTMLTextAreaElement).value), {
        timeout: 3_000,
      })
      .toBe('');

    // 新 user 气泡出现，且内容带两行文字。
    await expect
      .poll(async () => countUserBubbles(page), { timeout: USER_BUBBLE_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(beforeCount + 1);

    const lastUserText = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.chat-panel__messages .message-row--user'));
      const last = rows[rows.length - 1];
      return last ? (last.textContent ?? '') : '';
    });
    expect(lastUserText).toContain('第一行');
    expect(lastUserText).toContain('第二行');

    await screenshot(page, 'chat-interaction-tc2-shift-enter');
  });

  // TC-3 空输入框 Enter 不发送：空 value 下按 Enter，不应新增 user 气泡。
  test('TC-3 空输入框 Enter 不发送', async () => {
    await ensureExpanded(page);
    const textarea = page.locator('.chat-input__textarea').first();

    await textarea.fill('');
    // 确认真空（避免残留 whitespace —— sendUserPrompt 里是 trim() 判定）。
    await expect
      .poll(async () => textarea.evaluate((el) => (el as HTMLTextAreaElement).value), {
        timeout: 1_000,
      })
      .toBe('');

    const before = await countUserBubbles(page);
    await textarea.press('Enter');

    // 稳定性窗口：2s 内 user 气泡数不增加。
    const start = Date.now();
    while (Date.now() - start < 2_000) {
      const now = await countUserBubbles(page);
      expect(now).toBe(before);
      await page.waitForTimeout(200);
    }

    await screenshot(page, 'chat-interaction-tc3-empty-enter');
  });
});
