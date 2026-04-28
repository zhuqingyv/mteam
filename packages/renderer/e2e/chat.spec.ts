// 对话：输入发送 → loading dots → agent 回复 → tool call 名称/耗时 → 列表滚动。
// 注意：真实 agent 回复依赖后端 + claude/codex CLI，测试里不强依赖模型返回速度；
// 只断言\"UI 立刻出现 loading dots\"和\"用户消息进入列表\"这类前端可控的部分。
import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/);
  }
}

test.describe('对话', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    const logoCls = (await page.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，对话不可用');
    await ensureExpanded(page);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('输入文字发送 → 用户气泡进入列表', async () => {
    const ta = page.locator('.chat-input__textarea').first();
    const content = `ping-${Date.now()}`;
    await ta.fill(content);
    await page.locator('.chat-input__send').first().click();
    // 用户气泡（role=user）渲染出来
    const userRow = page.locator('.message-row--user').filter({ hasText: content }).first();
    await expect(userRow).toBeVisible({ timeout: 3_000 });
    await screenshot(page, 'chat-user-sent');
  });

  test('发送后立刻出现 loading dots（thinking 占位）', async () => {
    const ta = page.locator('.chat-input__textarea').first();
    await ta.fill(`think-${Date.now()}`);
    await ta.press('Enter');
    // thinking 气泡由 ExpandedView 的 pending-* 消息立即插入
    const dots = page.locator('.typing-dots').first();
    await expect(dots).toBeVisible({ timeout: 1_500 });
  });

  test('消息列表容器可滚动（VirtualList 存在）', async () => {
    // ChatPanel__messages 是滚动容器；断言存在即可（滚动本身由 VirtualList 负责）
    const scroller = page.locator('.chat-panel__messages').first();
    await expect(scroller).toBeVisible();
    const overflowY = await scroller.evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(overflowY);
  });

  test('tool call 渲染时显示名称（若当前有 tool block）', async () => {
    // 不强制 agent 回复 tool，只做 soft 检查：出现 tool-list 就断言至少一个 item 的 name 非空。
    const tool = page.locator('.tool-list').first();
    if ((await tool.count()) === 0) test.skip(true, '当前没有 tool 调用');
    const firstName = tool.locator('.tool-item__name').first();
    await expect(firstName).toBeVisible();
    const name = (await firstName.textContent())?.trim() ?? '';
    expect(name.length).toBeGreaterThan(0);
    // duration 可选（running 状态没有）；若有则不为空
    const dur = tool.locator('.tool-item__duration').first();
    if ((await dur.count()) > 0) {
      const d = (await dur.textContent())?.trim() ?? '';
      expect(d.length).toBeGreaterThan(0);
    }
  });
});
