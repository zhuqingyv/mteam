// 跨 peer 消息隔离：主 Agent 展开态发的消息，不能串到团队画布节点的私聊面板里。
//
// 背景：用户截图发现催退话术（主 Agent 和 leader 聊的话）泄露到了另一个 instance 的
// 聊天窗口。本 spec 用最小可控路径复现"只发一条、跨窗口核对一次"，UI 全链路，零 mock。
//
// 路径（完全走 UI，唯一例外：afterAll 清场）：
//   1. 连 CDP → 主窗口 waitMainReady
//   2. 展开胶囊（.card__collapsed 点击 → .card--expanded）
//   3. 在主 Agent 的 chat 输入框发 "isolation-test-<ts>"（唯一标识）
//   4. 等主窗 user 气泡出现 → 断言主窗聊天列表里包含该标识
//   5. ToolBar → 成员面板（aria-label="成员面板"） → window=roles
//   6. roles header 团队按钮（Icon name="team"，path d 前缀 "M12 12a3.5 3.5"）→ window=team
//   7. 如果画布有 .canvas-node[data-instance-id]，点第一个展开 → .canvas-node--expanded
//   8. 在展开节点内搜 .instance-chat-panel，断言不包含 "isolation-test-<ts>"
//   9. 两窗口各截一张
//
// 前置：Electron dev 已跑、CDP 9222 可连、主 Agent online。
// 断言核心：消息属于发送它的那个 instance 桶，不应出现在任何其他 instance 的聊天里。
//
// 注意：
//   - 如果没有任何团队 / 画布无节点，本 spec 的"串消息"场景无从验证，test.skip 并说明原因
//     —— 比静默通过好。Team Lead 若要强制覆盖该场景，应先跑 Phase4 S1 造团队再跑本 spec。
//   - React 18 setState flush ~200ms；WS 事件 + Electron 开窗 ~1~3s。
//   - beforeEach 不再创建团队（任务明确"如果画布有节点"才点），保持纯观测者姿态。
import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const TEAM_WINDOW_TIMEOUT_MS = 5_000;
const ROLES_WINDOW_TIMEOUT_MS = 5_000;
const USER_BUBBLE_TIMEOUT_MS = 3_000;
// 主 Agent 回复不强制等完，只要用户气泡先进主窗列表；下游断言只看 DOM 文本差异，不依赖 reply
const AGENT_REPLY_GRACE_MS = 3_000;

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

// ToolBar 成员面板入口 → 先开 window=roles，再点 header 团队按钮 → window=team。
// 与 phase4-canvas.spec.ts 的 fallback 路径一致（见 TC-5/TC-6 注释）。
async function openTeamWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();

  const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
    timeoutMs: ROLES_WINDOW_TIMEOUT_MS,
  });
  await rolesPage
    .locator('.role-list-page__header')
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });

  // roles header 右上角团队按钮：Icon name="team"，svg path d 以 "M12 12a3.5 3.5" 开头
  const teamPathPrefix = 'M12 12a3.5 3.5';
  const teamBtn = rolesPage
    .locator('.role-list-page__tools button')
    .filter({ has: rolesPage.locator(`svg path[d^="${teamPathPrefix}"]`) })
    .first();
  await expect(teamBtn).toBeVisible({ timeout: 3_000 });
  await teamBtn.click();

  const teamPage = await findPageByUrl(browser, (u) => u.includes('window=team'), {
    timeoutMs: TEAM_WINDOW_TIMEOUT_MS,
  });
  await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
  await teamPage.waitForTimeout(REACT_FLUSH_MS);
  return teamPage;
}

test.describe.configure({ mode: 'serial' });

test.describe('跨 peer 消息隔离', () => {
  let browser: Browser;
  let mainPage: Page;
  let teamPage: Page | null = null;
  // 整个 describe 共用一条标识，方便跨 test 断言 + 截图对比
  const marker = `isolation-test-${Date.now()}`;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    mainPage = await getMainPage(browser);
    await waitMainReady(mainPage);

    const logoCls =
      (await mainPage.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, '主 Agent 未 online，无法发消息');

    await closeAuxWindows(browser);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    await browser.close();
  });

  // S1 主窗发唯一标识消息 → 主窗 user 气泡出现
  test('S1 主 Agent 展开态发 isolation-test 消息', async () => {
    await ensureExpanded(mainPage);

    const ta = mainPage.locator('.chat-input__textarea').first();
    await expect(ta).toBeVisible({ timeout: 2_000 });
    await ta.fill(marker);
    await mainPage.locator('.chat-input__send').first().click();

    const userRow = mainPage
      .locator('.message-row--user')
      .filter({ hasText: marker })
      .first();
    await expect(userRow).toBeVisible({ timeout: USER_BUBBLE_TIMEOUT_MS });

    // 给 WS 一点时间推送可能的跨窗口副作用（错误实现会把消息广播到别的桶）
    await mainPage.waitForTimeout(AGENT_REPLY_GRACE_MS);

    await screenshot(mainPage, 'msg-isolation-main-sent');
  });

  // S2 主窗列表里能找到该标识（正向存在性，反面印证下游的不存在断言）
  test('S2 主窗聊天列表包含该标识', async () => {
    // ChatPanel 的消息容器：.chat-panel__messages；主窗是主 Agent 专属 chat（非 InstanceChatPanel）
    const messages = mainPage.locator('.chat-panel__messages').first();
    await expect(messages).toBeVisible();

    const hit = messages.locator('.message-row--user').filter({ hasText: marker });
    await expect(hit).toHaveCount(1, { timeout: 2_000 });
  });

  // S3 打开 team 窗口（ToolBar → 成员面板 → roles → 团队按钮）
  test('S3 通过 UI 打开 team 窗口', async () => {
    teamPage = await openTeamWindow(browser, mainPage);
    await expect(teamPage.locator('.panel-window').first()).toBeVisible();
    await screenshot(teamPage, 'msg-isolation-team-open');
  });

  // S4 核心断言：team 窗口的任何 chat 区域里都没有 marker。
  //   - 如果画布有节点 → 点第一个展开 → 断言展开态 .instance-chat-panel 不含 marker
  //   - 如果没有节点（无团队 / 画布空）→ test.skip 并说明；本场景无法验证串消息
  test('S4 team 窗口展开节点后私聊面板不含主窗消息', async () => {
    expect(teamPage, 'teamPage 必须由 S3 准备好').not.toBeNull();
    const tp = teamPage!;

    // 先等 React flush，画布 WS snapshot 可能还在赶来
    await tp.waitForTimeout(REACT_FLUSH_MS);

    const nodes = tp.locator('.canvas-node[data-instance-id]');
    const nodeCount = await nodes.count();

    if (nodeCount === 0) {
      // 画布为空：先保留截图证据再 skip，避免"静默通过"
      await screenshot(tp, 'msg-isolation-team-empty');
      test.skip(true, '画布无节点（无团队），无法验证跨 peer 串消息场景');
      return;
    }

    // 点第一个收起态节点展开（与 phase4-canvas P4-S4 一致的 click 姿势）
    const collapsedNode = tp
      .locator('.canvas-node[data-instance-id]:not(.canvas-node--expanded)')
      .first();
    await expect(collapsedNode).toBeVisible({ timeout: 3_000 });
    await collapsedNode.click();

    const expanded = tp.locator('.canvas-node.canvas-node--expanded').first();
    await expect(expanded).toBeVisible({ timeout: 3_000 });

    // 展开态右侧是 .instance-chat-panel（见 CanvasNodeChatBody 结构）
    const instanceChat = expanded.locator('.instance-chat-panel').first();
    await expect(instanceChat).toBeVisible({ timeout: 3_000 });

    // 再给一点时间让可能存在的错误广播把消息贴到这个桶里 —— 如果隔离是对的，
    // 等多久都不会出现。
    await tp.waitForTimeout(AGENT_REPLY_GRACE_MS);

    // 核心断言 1：.instance-chat-panel 里没有任何 message-row 命中 marker
    const leaked = instanceChat.locator('.message-row').filter({ hasText: marker });
    await expect(
      leaked,
      `隔离失败：marker "${marker}" 泄漏到展开节点的 .instance-chat-panel`,
    ).toHaveCount(0);

    // 核心断言 2：更严格的兜底 —— 整个展开节点 DOM 里也不含 marker 文本
    // （防止未来把消息塞到 header/tool-list 等非 message-row 区域仍被当成泄漏）
    const anyWithText = expanded.locator(`*:has-text("${marker}")`);
    await expect(
      anyWithText,
      `隔离失败：marker "${marker}" 出现在展开节点任意位置`,
    ).toHaveCount(0);

    await screenshot(tp, 'msg-isolation-team-node-expanded');
  });

  // S5 二次正向证据：再回主窗，marker 还在（不是被意外清理）
  test('S5 回主窗，marker 仍在列表里', async () => {
    await mainPage.bringToFront();
    const hit = mainPage
      .locator('.chat-panel__messages .message-row--user')
      .filter({ hasText: marker });
    await expect(hit).toHaveCount(1);
    await screenshot(mainPage, 'msg-isolation-main-final');
  });
});
