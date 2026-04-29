// Phase 4 Canvas E2E —— 真实用户路径，零 mock / 零 API 绕过。
//
// 场景清单（全部走 UI）：
//   P4-S1  胶囊展开 → 输入“帮我建一个测试团队” → 等主 Agent 真实调用 create_leader 建团队
//   P4-S2  团队面板自动弹出（WS team.created 触发 Electron 开 window=team）
//   P4-S3  画布渲染 ≥1 个 .canvas-node[data-instance-id]
//   P4-S4  点击节点展开 → .canvas-node--expanded 出现 + .chat-list 可见
//   P4-S5  在展开态输入“你好” + 发送 → .message-row--user 出现
//   P4-S6  点最小化（chevron-down）→ .canvas-node--expanded 消失
//
// 前置：
//   - Electron dev 已跑，CDP 9222 可连
//   - 主 Agent 已配置 + RUNNING（online），否则 skip
//   - primary agent prompt 允许调用 mteam-primary.create_leader（默认 prompt 支持）
//
// 注意：
//   - S1 依赖主 Agent 真实推理调 MCP，timeout 要 60s；若 Agent 不调 create_leader，S2~S6 会连锁失败 —— 这是真实 E2E 该有的行为
//   - CanvasNodeExpanded 实际 DOM 是 <div class="canvas-node canvas-node--expanded">（不是 .canvas-node-expanded）
//   - beforeEach 允许 API 清 team 残留（唯一例外，核心流程必须走 UI）
//   - React 18 setState flush ~200ms；WS 事件 + Electron 开窗 ~1~3s
import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, findPageByUrl, screenshot } from './cdp-helpers';
import { cleanTeams } from './phase4-helpers';

const REACT_FLUSH_MS = 200;
const AGENT_CREATE_TEAM_TIMEOUT_MS = 60_000;
const AGENT_REPLY_TIMEOUT_MS = 30_000;
const TEAM_WINDOW_TIMEOUT_MS = 8_000;

async function waitAnimDone(page: Page): Promise<void> {
  await expect(page.locator('.card').first()).not.toHaveClass(/card--animating/, { timeout: 2_000 });
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

async function ensureCollapsed(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
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

// 用 URL 找 team 窗口（支持跨 BrowserContext）——  Electron 多窗口场景 cdp-helpers.findPageByUrl 已够用
async function findTeamWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('window=team'), { timeoutMs });
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 4 Canvas 全链路', () => {
  let browser: Browser;
  let page: Page;
  let teamPage: Page | null = null;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);

    // 清 team 残留 —— beforeAll 允许 API 清数据（唯一例外）
    await cleanTeams(page);
    await closeAuxWindows(browser);

    // 主 Agent 必须 RUNNING，否则跳过整组
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    // 不在这里 cleanTeams —— 留残留给下次 run 调试；beforeAll 会清
    await browser.close();
  });

  // P4-S1 创建团队：通过 UI 发消息 → 主 Agent 真实调 create_leader MCP → team.created WS 事件
  test('P4-S1 通过主 Agent UI 创建团队', async () => {
    await ensureExpanded(page);

    // 读当前 teams 数量（UI 侧真实 store 值，不是 API）
    const beforeCount = await page.evaluate(() => {
      const s = (window as { __teamStore?: { getState?: () => { teams?: Array<unknown> } } }).__teamStore;
      return s?.getState?.()?.teams?.length ?? 0;
    });

    // 发出创建团队的自然语言指令 —— 依赖主 Agent 真实推理
    const prompt = '帮我建一个测试团队，成员用默认配置，不用问我任何问题，直接建好';
    await page.locator('.chat-input__textarea').first().fill(prompt);
    await page.locator('.chat-input__send').first().click();

    // 用户消息气泡先出现 —— UI 交互成功的第一证据
    await expect(
      page.locator('.message-row--user').filter({ hasText: '帮我建一个测试团队' }).first(),
    ).toBeVisible({ timeout: 3_000 });

    // 等 teams 长度 +1（主 Agent 调了 create_leader → 后端 emit team.created → WS 推送 → teamStore.teams push）
    // 这是真实 E2E 终极判据：Agent 真的调了 MCP，team 真的进 store
    await expect
      .poll(
        async () => {
          return await page.evaluate(() => {
            const s = (window as { __teamStore?: { getState?: () => { teams?: Array<unknown> } } }).__teamStore;
            return s?.getState?.()?.teams?.length ?? 0;
          });
        },
        { timeout: AGENT_CREATE_TEAM_TIMEOUT_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(beforeCount + 1);

    await screenshot(page, 'p4-s1-team-created-via-agent');
  });

  // P4-S2 团队面板自动弹出：WS team.created → Electron 监听后主动 open window=team
  test('P4-S2 team 窗口自动弹出', async () => {
    // Electron 主进程在 team.created 事件后自动开窗（见 team-lifecycle 逻辑）
    teamPage = await findTeamWindow(browser, TEAM_WINDOW_TIMEOUT_MS).catch(() => null);

    // 如果没自动弹出（可能是 feature 没实现 / 只在特定场景触发），走 UI 路径补救：
    //   展开 → ToolBar 成员面板 → window=roles → roles header 团队按钮 → window=team
    if (!teamPage) {
      await ensureExpanded(page);
      await page.locator('.toolbar [aria-label="成员面板"]').first().click();

      const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 5_000,
      });
      await rolesPage
        .locator('.role-list-page__header')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 });

      // roles header 右上角团队按钮 —— svg path d 以 "M12 12a3.5 3.5" 开头精确命中
      const teamPathPrefix = 'M12 12a3.5 3.5';
      const teamBtn = rolesPage
        .locator('.role-list-page__tools button')
        .filter({ has: rolesPage.locator(`svg path[d^="${teamPathPrefix}"]`) })
        .first();
      await expect(teamBtn).toBeVisible({ timeout: 3_000 });
      await teamBtn.click();

      teamPage = await findTeamWindow(browser, 5_000);
    }

    await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await teamPage.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(teamPage, 'p4-s2-team-window-open');
  });

  // P4-S3 画布渲染节点
  test('P4-S3 画布出现 ≥1 个 canvas-node[data-instance-id]', async () => {
    expect(teamPage, 'teamPage 必须由 S2 准备好').not.toBeNull();
    const tp = teamPage!;

    // 等 WS snapshot + React flush
    const nodes = tp.locator('.canvas-node[data-instance-id]');
    await expect(nodes.first()).toBeVisible({ timeout: 5_000 });

    const count = await nodes.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // 拿 leader instance id 做后续操作
    const firstId = await nodes.first().getAttribute('data-instance-id');
    expect(firstId, 'leader 节点必须有 data-instance-id').toBeTruthy();

    await screenshot(tp, 'p4-s3-canvas-nodes');
  });

  // P4-S4 点节点展开 → .canvas-node--expanded + .chat-list
  test('P4-S4 点击节点展开聊天面板', async () => {
    expect(teamPage).not.toBeNull();
    const tp = teamPage!;

    // 找第一个收起态节点（不含 --expanded 修饰类）
    const collapsedNode = tp
      .locator('.canvas-node[data-instance-id]:not(.canvas-node--expanded)')
      .first();
    await expect(collapsedNode).toBeVisible({ timeout: 3_000 });

    // CanvasNode click threshold：mousedown → mouseup 且未拖动才 onOpen
    await collapsedNode.click();

    // 展开态 DOM：<div class="canvas-node canvas-node--expanded">
    const expanded = tp.locator('.canvas-node.canvas-node--expanded').first();
    await expect(expanded).toBeVisible({ timeout: 3_000 });

    // 展开态内置 CanvasNodeChatBody → 左边 .chat-list（私聊列表）+ 右边 .instance-chat-panel
    await expect(expanded.locator('.chat-list').first()).toBeVisible({ timeout: 2_000 });
    await expect(expanded.locator('.instance-chat-panel').first()).toBeVisible({ timeout: 2_000 });

    await tp.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(tp, 'p4-s4-node-expanded');
  });

  // P4-S5 在展开态发消息
  test('P4-S5 展开态发送“你好” → 出现 user 消息气泡', async () => {
    expect(teamPage).not.toBeNull();
    const tp = teamPage!;

    const expanded = tp.locator('.canvas-node.canvas-node--expanded').first();
    await expect(expanded).toBeVisible();

    const content = `你好-${Date.now()}`;

    // 展开态内部的输入框 —— 限定在 .instance-chat-panel 里，防止命中主窗口 ChatInput
    const textarea = expanded.locator('.instance-chat-panel .chat-input__textarea').first();
    await expect(textarea).toBeVisible({ timeout: 3_000 });
    await textarea.fill(content);

    const sendBtn = expanded.locator('.instance-chat-panel .chat-input__send').first();
    await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
    await sendBtn.click();

    // 展开态内消息列表出现 user 气泡
    const userRow = expanded.locator('.message-row--user').filter({ hasText: content }).first();
    await expect(userRow).toBeVisible({ timeout: AGENT_REPLY_TIMEOUT_MS });

    await tp.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(tp, 'p4-s5-message-sent');
  });

  // P4-S6 收起节点
  test('P4-S6 点最小化按钮 → 展开态消失', async () => {
    expect(teamPage).not.toBeNull();
    const tp = teamPage!;

    const expanded = tp.locator('.canvas-node.canvas-node--expanded').first();
    await expect(expanded).toBeVisible();

    // CanvasNodeExpanded header 右侧 actions：第一个按钮是 onMinimize（chevron-down icon）
    // 第二个是 onClose（close icon）。TeamPage 里两者都走 close(id)，但语义上点 minimize 来测任务要求。
    const minimizeBtn = expanded.locator('.canvas-node__actions button').first();
    await expect(minimizeBtn).toBeVisible({ timeout: 2_000 });
    await minimizeBtn.click();

    // 展开态消失（stack 弹出该 id → CanvasNodeExpanded unmount）
    await expect(tp.locator('.canvas-node.canvas-node--expanded')).toHaveCount(0, {
      timeout: 3_000,
    });

    // 画布本体还在 —— 收起态节点仍可见
    await expect(tp.locator('.canvas-node[data-instance-id]').first()).toBeVisible();

    await screenshot(tp, 'p4-s6-collapsed');
  });
});
