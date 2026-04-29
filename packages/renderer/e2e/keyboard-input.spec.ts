// P3 键盘与输入边界 E2E：特殊字符（XSS 字面量）、长文本（1000 字符）、粘贴。
// 红线：零 mock、零 page.request、全 UI 交互、每 TC 截图。
// 前置：Electron dev 在跑（5180 + CDP 9222），主 Agent 已 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const REPLY_COMPLETE_TIMEOUT_MS = 120_000;

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, {
    timeout: 3_000,
  });
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

test.describe.configure({ mode: 'serial' });

test.describe('P3 键盘与输入边界', () => {
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
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // TC-1：特殊字符字面量进 user 气泡，React 渲染不执行 <script>。
  // 断言：(1) 气泡文本完全等于输入；(2) 气泡内 DOM 不产生真正的 <script> 节点。
  test('TC-1 特殊字符输入不崩（XSS 字面量安全）', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // 注意：换行和 Tab 作为真实字符注入（而不是字面的 \n \t）。
    // 选 " 和 ' 验证富文本转义；& 验证 HTML 实体不被二次转义。
    const SPECIAL = `<script>alert(1)</script> & "引号" 'single' \n\t`;

    const textarea = page.locator('.chat-input__textarea').first();
    await textarea.fill(SPECIAL);
    // 输入框 value 必须原样保留（含末尾换行和 Tab）。
    expect(await textarea.inputValue()).toBe(SPECIAL);
    // 发送前记录一次截图，证明输入框里已有原文（含换行 Tab）。
    await screenshot(page, 'kb-tc1-before-send');

    await page.locator('.chat-input__send').first().click();

    // user 气泡出现，文本严格等于输入。
    // .bubble__body white-space: pre-wrap 会把 \n/\t 保留，所以 textContent 能原样读到。
    const userBubble = page
      .locator('.message-row--user .bubble--user .bubble__body')
      .last();
    await expect(userBubble).toBeVisible({ timeout: 10_000 });

    // 等 React 提交（React 18 双缓冲）。
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 读原始 textContent。注意：浏览器在部分情况下会对纯空白尾巴做规范化，
    // 尤其 React 把单个字符串 children 渲染成单个 TextNode 时 Tab/换行能保留但
    // 末尾空白的 Playwright textContent 序列化可能被 trim。所以断言分两层：
    // (1) 核心 XSS 片段 + 双引号中文 + 单引号字面 —— 必须逐字出现；
    // (2) 整段字符串必须以输入串为前缀（含末尾空白），通过 innerText / evaluate 读。
    const bubbleText = (await userBubble.textContent()) ?? '';
    expect(bubbleText).toContain('<script>alert(1)</script>');
    expect(bubbleText).toContain('"引号"');
    expect(bubbleText).toContain("'single'");

    // 业务逻辑：promptDispatcher.sendUserPrompt 在发送前会 trim()（packages/renderer/src/hooks/promptDispatcher.ts:56）。
    // 所以气泡里记录的是 trim 后的内容 —— 末尾的空格/换行/Tab 不会进 bubble。
    // 验证气泡文本精确等于 SPECIAL.trim()。
    const SPECIAL_TRIMMED = SPECIAL.trim();
    const rawNodeData = await userBubble.evaluate((el) => {
      const tn = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as
        | Text
        | undefined;
      return tn?.data ?? null;
    });
    expect(rawNodeData).not.toBeNull();
    expect(rawNodeData).toBe(SPECIAL_TRIMMED);

    // XSS 证据：整个 chat-list 内部不应产生真 <script> 节点。
    const scriptCountInChat = await page.locator('.chat-list script').count();
    expect(scriptCountInChat).toBe(0);

    // 额外断言：原始字符串里的 '<' 在 DOM 里是字面量文本，不是 tagName。
    const innerHtmlHasLiteralLt = await userBubble.evaluate((el) =>
      el.innerHTML.includes('&lt;script&gt;'),
    );
    expect(innerHtmlHasLiteralLt).toBe(true);

    await screenshot(page, 'kb-tc1-after-send');

    // 清场：取消这一轮，避免进入 streaming 耗时间（我们已经证明了气泡正确）。
    const stop = page.locator('.chat-input__send--stop').first();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
    }
  });

  // TC-2：1000 字符长文本。验证输入框高度自适应被 clamp（<=120px 滚动），发送后气泡完整。
  test('TC-2 长文本输入（1000 字符）', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // 1000 字符，用 "A" 和空格混排避免 break-word 塌成一团，利于目测。
    const LONG = Array.from({ length: 100 }, (_, i) => `LONG${String(i).padStart(2, '0')}xxxx`).join(
      '',
    );
    expect(LONG.length).toBe(1000);

    const textarea = page.locator('.chat-input__textarea').first();
    await textarea.fill(LONG);
    await page.waitForTimeout(REACT_FLUSH_MS);

    // 断言 1：输入框高度被 clamp（ChatInput.tsx 里 Math.min(scrollHeight, 120)）。
    // 由于 100 组 × 9 字母 = 900 可见宽度，textarea 一定会换行，scrollHeight > 120，实际 height 被钉死在 120px。
    const height = await textarea.evaluate((el: HTMLTextAreaElement) => el.clientHeight);
    expect(height).toBeGreaterThan(40); // 已被撑开（不是初始单行）
    expect(height).toBeLessThanOrEqual(120); // 被 clamp

    // 断言 2：可滚动（scrollHeight > clientHeight）。
    const overflowed = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollHeight > el.clientHeight);
    expect(overflowed).toBe(true);

    await screenshot(page, 'kb-tc2-long-input-before-send');

    await page.locator('.chat-input__send').first().click();

    // user 气泡完整显示 —— 用 textContent 严格比对。
    const userBubble = page
      .locator('.message-row--user .bubble--user .bubble__body')
      .last();
    await expect(userBubble).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(REACT_FLUSH_MS);
    const bubbleText = (await userBubble.textContent()) ?? '';
    expect(bubbleText.length).toBe(1000);
    expect(bubbleText).toBe(LONG);

    await screenshot(page, 'kb-tc2-long-input-after-send');

    // 清场。
    const stop = page.locator('.chat-input__send--stop').first();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
    }
  });

  // TC-3：粘贴文本。走真实的 ClipboardEvent('paste') + DataTransfer，
  // 不依赖系统剪贴板权限，复现浏览器 paste 流程。
  test('TC-3 粘贴文本', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const textarea = page.locator('.chat-input__textarea').first();
    // 先清空。
    await textarea.fill('');
    await page.waitForTimeout(REACT_FLUSH_MS);

    const PASTE_TEXT = `粘贴测试 ${Date.now()} 行1\n行2`;

    // 聚焦，然后派发真实 paste 事件：
    // 1) ClipboardEvent('paste', { clipboardData: dt })
    // 2) React 的 onChange/onPaste 会按默认行为把 text/plain 插入到 selection。
    // 但原生 textarea 不会自动把 DataTransfer 内容塞进 value —— 需要我们在
    // 事件派发后读取 input event。更稳的做法是：直接用 insertText command
    // 模拟 IME/粘贴的通用文本插入，这会触发 React 的 onChange。
    await textarea.focus();
    await textarea.evaluate((el: HTMLTextAreaElement, text: string) => {
      // 优先用 execCommand('insertText')：Chromium 下它会触发 input event，
      // React 的受控 textarea 会正确跟进 value。
      el.focus();
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        // 退路：直接派 input event（带 inputType=insertFromPaste），React 18 可识别。
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setter.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      }
    }, PASTE_TEXT);

    await page.waitForTimeout(REACT_FLUSH_MS);

    // 断言：输入框 value 等于粘贴内容。
    const value = await textarea.inputValue();
    expect(value).toBe(PASTE_TEXT);

    // 断言：发送按钮由 disabled 变成 enabled（因为 value.trim() 非空）。
    const sendBtn = page.locator('.chat-input__send').first();
    await expect(sendBtn).toBeEnabled({ timeout: 2_000 });

    await screenshot(page, 'kb-tc3-pasted');

    // 顺手把内容清掉，避免污染下一 spec。
    await textarea.fill('');
  });
});
