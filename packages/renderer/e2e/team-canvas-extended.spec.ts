// Phase 4 Team Canvas 扩展 E2E —— 真实用户路径，零 mock / 零 API 绕过。
//
// 场景清单（全部走 UI）：
//   TC-A2  leader 加 member → 画布新增节点
//     主 Agent 已建 team（phase4-canvas P4-S1 的模式复用）→ 胶囊展开态发"给这个团队加一个前端开发成员"
//     → 等主 Agent 真实调 add_member MCP → team 窗 canvas-node 数量 ≥ 2
//
//   TC-A5  成员间 comm 通信（观察层面）
//     团队已有 leader + member → 点 leader 节点展开 → ChatList 里看到 ≥ 2 个 peer item（user + 至少一个 agent）
//     真实 comm 消息依赖 leader agent 的自主推理（不可控），不强断言 lastMessage
//
// 前置：
//   - Electron dev 已跑，CDP 9222 可连
//   - 主 Agent 已配置 + RUNNING（online），否则整组 skip
//   - primary agent prompt 允许调用 mteam-primary.create_leader / add_member（默认 prompt 支持）
//
// 红线：
//   - 零 mock、零 page.request（唯一例外：beforeAll cleanTeams 清残留）
//   - 所有操作走 Playwright UI（click / fill / keyboard）
//   - Agent 真实推理，不塞预设回复
//
// 实现要点：
//   - TC-A2 依赖 TC-A2 本身建 team（自含流程），不依赖外部 spec 先跑
//   - leader 节点定位：.canvas-node.canvas-node--leader
//   - ChatList peer item DOM：.chat-list__item（见 src/molecules/ChatList/ChatListItem.tsx）
//   - leader 展开态 peers = user + 其他 members（见 src/store/selectors/instanceChat.ts selectPeersFor）
import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';
import { cleanTeams } from './phase4-helpers';

const REACT_FLUSH_MS = 200;
const AGENT_CREATE_TEAM_TIMEOUT_MS = 60_000;
const AGENT_ADD_MEMBER_TIMEOUT_MS = 90_000;
const TEAM_WINDOW_TIMEOUT_MS = 8_000;

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

async function findTeamWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('window=team'), { timeoutMs });
}

// 打开 team 窗口：优先找已开的；没开就走 UI 路径（展开 → 成员面板 → roles header 团队按钮）。
async function openTeamWindow(browser: Browser, mainPage: Page): Promise<Page> {
  const existing = await findTeamWindow(browser, 500).catch(() => null);
  if (existing) return existing;

  await ensureExpanded(mainPage);
  await mainPage.locator('.toolbar [aria-label="成员面板"]').first().click();

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

  return findTeamWindow(browser, 5_000);
}

// 读 teamStore.teams.length —— renderer 侧真实 store 值。
async function readTeamsCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = (window as { __teamStore?: { getState?: () => { teams?: Array<unknown> } } })
      .__teamStore;
    return s?.getState?.()?.teams?.length ?? 0;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 4 Team Canvas 扩展', () => {
  let browser: Browser;
  let page: Page;
  let teamPage: Page | null = null;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);

    // 清 team 残留 —— 唯一允许的 API 调用
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
    await browser.close();
  });

  // ---- 前置：复用 phase4-canvas P4-S1 模式建 team ----
  // 这组 spec 不串在 phase4-canvas 之后跑，必须自带建 team 步骤。
  test('前置 通过主 Agent UI 创建团队', async () => {
    test.setTimeout(150_000); // 60s create + 30s turn-end + 余量
    await ensureExpanded(page);

    const beforeCount = await readTeamsCount(page);

    const prompt = '帮我建一个测试团队，成员用默认配置，不用问我任何问题，直接建好';
    await page.locator('.chat-input__textarea').first().fill(prompt);
    await page.locator('.chat-input__send').first().click();

    await expect(
      page.locator('.message-row--user').filter({ hasText: '帮我建一个测试团队' }).first(),
    ).toBeVisible({ timeout: 3_000 });

    // 等 teams 长度 +1 —— Agent 真调了 create_leader，team 真进 store
    await expect
      .poll(async () => readTeamsCount(page), {
        timeout: AGENT_CREATE_TEAM_TIMEOUT_MS,
        intervals: [1_000, 2_000, 3_000],
      })
      .toBe(beforeCount + 1);

    // 等当前 turn 结束（streaming → send 按钮复位），避免并发两个 turn
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: 30_000 });

    await screenshot(page, 'tc-a-prep-team-created');
  });

  // TC-A2 leader 加 member → 画布新增节点
  test('TC-A2 leader 加 member → 画布新增节点', async () => {
    test.setTimeout(150_000); // 90s add_member + 余量
    await ensureExpanded(page);

    // 打开 team 窗（自动弹出或走 UI 路径）
    teamPage = await openTeamWindow(browser, page);
    await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    // 记录加 member 前画布节点数
    const nodes = teamPage.locator('.canvas-node[data-instance-id]');
    await expect(nodes.first()).toBeVisible({ timeout: 5_000 });
    const beforeCount = await nodes.count();

    // 回到主窗输入框，发"加前端开发成员"
    await ensureExpanded(page);
    const textarea = page.locator('.chat-input__textarea').first();
    await expect(textarea).toBeVisible({ timeout: 3_000 });
    await expect(textarea).toBeEnabled({ timeout: 3_000 });
    const prompt = '给这个团队加一个前端开发成员，用默认模板，不用问我任何问题，直接加好';
    await textarea.fill(prompt);
    await page.locator('.chat-input__send').first().click();

    await expect(
      page.locator('.message-row--user').filter({ hasText: '给这个团队加一个前端开发成员' }).first(),
    ).toBeVisible({ timeout: 3_000 });

    // 等画布节点数增加（Agent 调 add_member → 后端 emit → WS → TeamCanvas 重绘）
    // 这是 TC-A2 终极判据
    await expect
      .poll(
        async () => {
          const tp = teamPage;
          if (!tp) return 0;
          return tp.locator('.canvas-node[data-instance-id]').count();
        },
        { timeout: AGENT_ADD_MEMBER_TIMEOUT_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .toBeGreaterThan(beforeCount);

    // 兜底：至少要有 leader + 新 member，共 ≥ 2
    const afterCount = await teamPage.locator('.canvas-node[data-instance-id]').count();
    expect(afterCount).toBeGreaterThanOrEqual(2);

    await teamPage.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(teamPage, 'tc-a2-member-added');
  });

  // TC-A5 成员间 comm 通信（观察层面）——  点 leader 节点看 peer 列表
  test('TC-A5 leader 节点 ChatList 显示 peer 列表', async () => {
    expect(teamPage, 'teamPage 必须由 TC-A2 准备好').not.toBeNull();
    const tp = teamPage!;

    // 找 leader 节点（.canvas-node--leader）—— 可能已被上一轮展开，需要先确认收起再点开
    const leaderNode = tp.locator('.canvas-node.canvas-node--leader').first();
    await expect(leaderNode).toBeVisible({ timeout: 3_000 });

    // 如果 leader 已处于展开态，先最小化，保证 click 语义是"点开"而不是"切回收起态"
    const isExpanded = await leaderNode.evaluate((el) =>
      el.classList.contains('canvas-node--expanded'),
    );
    if (isExpanded) {
      const minimizeBtn = leaderNode.locator('.canvas-node__actions button').first();
      await minimizeBtn.click();
      await expect(
        tp.locator('.canvas-node.canvas-node--leader.canvas-node--expanded'),
      ).toHaveCount(0, { timeout: 3_000 });
    }

    // 点 leader 节点收起态主体区域
    const leaderCollapsed = tp
      .locator('.canvas-node.canvas-node--leader:not(.canvas-node--expanded)')
      .first();
    await expect(leaderCollapsed).toBeVisible({ timeout: 3_000 });
    await leaderCollapsed.click();

    // 展开态出现（只限定 leader 节点）
    const leaderExpanded = tp
      .locator('.canvas-node.canvas-node--leader.canvas-node--expanded')
      .first();
    await expect(leaderExpanded).toBeVisible({ timeout: 3_000 });

    // ChatList 容器可见
    const chatList = leaderExpanded.locator('.chat-list').first();
    await expect(chatList).toBeVisible({ timeout: 3_000 });

    // peer item 数 ≥ 2（user + 至少一个 agent：其他 team members）
    const peerItems = chatList.locator('.chat-list__item');
    await expect
      .poll(async () => peerItems.count(), { timeout: 5_000, intervals: [200, 500, 1_000] })
      .toBeGreaterThanOrEqual(2);

    // user peer 必须在
    const userPeer = chatList.locator('.chat-list__item--role-user').first();
    await expect(userPeer).toBeVisible({ timeout: 2_000 });

    // 至少有一个非 user peer（member/leader role）—— 由 TC-A2 新加的 member 贡献
    const nonUserPeers = chatList.locator(
      '.chat-list__item--role-member, .chat-list__item--role-leader',
    );
    await expect
      .poll(async () => nonUserPeers.count(), { timeout: 3_000, intervals: [200, 500] })
      .toBeGreaterThanOrEqual(1);

    await tp.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(tp, 'tc-a5-leader-peer-list');
  });
});
