// 全链路硬核验证 —— 从主 Agent → teamCanvas 节点展开 → 真实成员通信。
//
// 用户旅程（禁止 mock、禁止 API 绕过 UI，仅 beforeAll/afterAll cleanTeams 允许 HTTP）：
//   1. 确认 Electron CDP 9222 可连
//   2. 确认主 Agent RUNNING（.logo--online）
//   3. 胶囊展开态输入"帮我建一个测试团队" → 等 Agent 真调 create_leader（timeout 90s）
//      → teamStore.teams 出现 baseline 之外的新 id
//   4. 等 team 窗口弹出（.panel-window 可见）
//   5. team 窗里等 .canvas-node 出现
//   6. 点击节点展开（.canvas-node--expanded）
//   7. 展开态输入"你好，请回复我" → 点发送
//   8. 等 Agent 真回复（.message-row--agent .bubble--agent 文字非空，timeout 60s）
//   9. 截图留证 + soft-fail 诊断（user 气泡 / stop 按钮 / error / DOM 完整截图）
//  10. afterAll cleanTeams 清理
//
// 与 chain-team-lifecycle 差异：
//   - 本 spec 全链路单 test() 内串联，重点在"第 8 步等 Agent 真回复"
//   - 失败时强制 dump 诊断信息（stop 按钮轨迹 / error / 完整 instance-chat-panel 截图）
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
const AGENT_CREATE_TEAM_TIMEOUT_MS = 90_000;
const TEAM_WINDOW_TIMEOUT_MS = 20_000;
const CANVAS_NODE_TIMEOUT_MS = 15_000;
// A+B 方案：leader 冷启动 3min+ 常见，给 180s 充分余量
const AGENT_REPLY_TIMEOUT_MS = 180_000;
// leader instance activated：data-status != "offline"（idle/thinking/responding 都算 online）
const LEADER_ONLINE_TIMEOUT_MS = 120_000;

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
      if (
        u.includes('window=team') ||
        u.includes('window=roles') ||
        u.startsWith('chrome-error://')
      ) {
        await p.close().catch(() => {});
      }
    }
  }
}

async function findTeamWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('window=team'), { timeoutMs });
}

async function waitTurnIdle(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: timeoutMs });
}

test.describe.configure({ mode: 'serial' });

test.describe('全链路硬核验证：从主 Agent 到 teamCanvas 真实通信', () => {
  // Step3 主 Agent 真实推理 90s + Step8 成员 Agent 真回复 60s + 冷启动 = 给 6min 充分余量
  test.setTimeout(360_000);

  let browser: Browser;
  let page: Page;
  let teamPage: Page | null = null;
  let baselineTeamIds: Set<string> = new Set();
  let createdTeamId: string | null = null;
  let createdTeamName: string | null = null;

  test.beforeAll(async () => {
    // Step1 CDP 可连（connectElectron 失败会直接抛 —— 视为 Electron 未跑）
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);

    await cleanTeams(page);
    await closeAuxWindows(browser);

    // Step2 主 Agent RUNNING
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await cleanTeams(page).catch(() => {});
    await closeAuxWindows(browser);
    await browser.close();
  });

  test('全链路：建团队 → 节点展开 → 发消息 → 等 Agent 真回复', async () => {
    // ---------- Step3 胶囊展开 + 主 Agent 建团队 ----------
    await ensureExpanded(page);
    await waitTurnIdle(page, 30_000);

    baselineTeamIds = new Set(
      await page.evaluate(() => {
        const s = (
          window as { __teamStore?: { getState?: () => { teams?: Array<{ id: string }> } } }
        ).__teamStore;
        return (s?.getState?.()?.teams ?? []).map((t) => t.id);
      }),
    );

    // 强制调用 MCP 工具，避免 Agent 纯文字回复
    const createPrompt =
      '请立即调用 mteam-primary 的 create_leader 工具，帮我建一个叫"测试团队"的团队，使用默认模板。不要回复文字，直接调用工具。';
    const textarea = page.locator('.chat-input__textarea').first();
    await expect(textarea).toBeVisible({ timeout: 3_000 });
    await expect(textarea).toBeEnabled({ timeout: 3_000 });
    await textarea.fill(createPrompt);
    await page.locator('.chat-input__send').first().click();

    await expect(
      page.locator('.message-row--user').filter({ hasText: 'create_leader' }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await screenshot(page, 'verify-chat-step3-prompt-sent');

    // 轮询 store 里 baseline 之外的新 team
    let newTeam: { id: string; name: string } | null = null;
    await expect
      .poll(
        async () => {
          newTeam = await page.evaluate((baseline: string[]) => {
            const base = new Set(baseline);
            const s = (
              window as {
                __teamStore?: {
                  getState?: () => { teams?: Array<{ id: string; name: string }> };
                };
              }
            ).__teamStore;
            const teams = s?.getState?.()?.teams ?? [];
            const hit = teams.find((t) => !base.has(t.id));
            return hit ? { id: hit.id, name: hit.name } : null;
          }, Array.from(baselineTeamIds));
          return newTeam;
        },
        { timeout: AGENT_CREATE_TEAM_TIMEOUT_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .toBeTruthy();

    createdTeamId = newTeam!.id;
    createdTeamName = newTeam!.name;
    expect(createdTeamId, 'createdTeamId 必须由 Agent 真调 create_leader 推入').toBeTruthy();

    // 等主 Agent turn 结束，避免与 Step7 的成员 turn 竞争
    await waitTurnIdle(page, 45_000);

    // ---------- Step4 team 窗口弹出 ----------
    teamPage = await findTeamWindow(browser, TEAM_WINDOW_TIMEOUT_MS).catch(() => null);

    if (!teamPage) {
      // 没自动弹 —— 走 UI 兜底：ToolBar 成员面板 → roles 窗团队按钮
      await ensureExpanded(page);
      await page.locator('.toolbar [aria-label="成员面板"]').first().click();

      const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 5_000,
      });
      await rolesPage
        .locator('.role-list-page__header')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 });

      const teamPathPrefix = 'M12 12a3.5 3.5';
      const teamBtn = rolesPage
        .locator('.role-list-page__tools button')
        .filter({ has: rolesPage.locator(`svg path[d^="${teamPathPrefix}"]`) })
        .first();
      await expect(teamBtn).toBeVisible({ timeout: 3_000 });
      await teamBtn.click();

      teamPage = await findTeamWindow(browser, 10_000);
    }

    await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await teamPage.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(teamPage, 'verify-chat-step4-team-window');

    // ---------- Step5 切到本轮 team + 等 .canvas-node 渲染 ----------
    const tp = teamPage;

    // 侧栏折叠时先展开，让 title 可见
    const collapsedCount = await tp.locator('aside.tsb--collapsed').count().catch(() => 0);
    if (collapsedCount > 0) {
      await tp.locator('.tsb__toggle').first().click().catch(() => {});
      await tp.waitForTimeout(REACT_FLUSH_MS);
    }

    // 精确点到本轮创建的 team（按 title 定位，多个同名取最后一个 — createdAt 最新）
    const items = tp.locator(`.tsb__row button[title="${createdTeamName}"]`);
    const total = await items.count();
    if (total > 0) {
      const targetItem = items.nth(total - 1);
      const isActive = await targetItem
        .evaluate((el) => el.classList.contains('tsi--active'))
        .catch(() => false);
      if (!isActive) await targetItem.click();
      await tp.waitForTimeout(REACT_FLUSH_MS);
    }

    const nodes = tp.locator('.canvas-node[data-instance-id]');
    await expect(nodes.first()).toBeVisible({ timeout: CANVAS_NODE_TIMEOUT_MS });
    const nodeCount = await nodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(1);

    await screenshot(tp, 'verify-chat-step5-canvas-node');

    // ---------- Step5b 等 leader 节点 online（A+B 方案 A）----------
    // CanvasNode data-status ∈ {'idle','thinking','responding','offline'}
    // online = 不是 offline。冷启动 leader 先 offline → 启动完成转 idle。
    const leaderNode = tp.locator('.canvas-node[data-instance-id]').first();
    let lastStatus = '';
    await expect
      .poll(
        async () => {
          lastStatus = (await leaderNode.getAttribute('data-status').catch(() => null)) ?? 'missing';
          return lastStatus;
        },
        { timeout: LEADER_ONLINE_TIMEOUT_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .not.toBe('offline');
    test.info().annotations.push({
      type: 'step5b-leader-online',
      description: `leader data-status="${lastStatus}"（非 offline 即 online）`,
    });
    await screenshot(tp, 'verify-chat-step5b-leader-online');

    // ---------- Step6 点击节点展开 ----------
    const firstNode = tp
      .locator('.canvas-node[data-instance-id]:not(.canvas-node--expanded)')
      .first();
    await expect(firstNode).toBeVisible({ timeout: 5_000 });
    await firstNode.click();

    const expanded = tp.locator('.canvas-node.canvas-node--expanded').first();
    await expect(expanded).toBeVisible({ timeout: 5_000 });
    await expect(expanded.locator('.instance-chat-panel').first()).toBeVisible({
      timeout: 3_000,
    });
    await tp.waitForTimeout(REACT_FLUSH_MS);
    await screenshot(tp, 'verify-chat-step6-expanded');

    // ---------- Step7 展开态输入"你好，请回复我" → 发送 ----------
    const content = `你好，请回复我-${Date.now()}`;

    const memberTextarea = expanded.locator('.instance-chat-panel .chat-input__textarea').first();
    await expect(memberTextarea).toBeVisible({ timeout: 3_000 });
    await expect(memberTextarea).toBeEnabled({ timeout: 3_000 });
    await memberTextarea.fill(content);

    const memberSendBtn = expanded.locator('.instance-chat-panel .chat-input__send').first();
    await expect(memberSendBtn).toBeEnabled({ timeout: 3_000 });
    await memberSendBtn.click();

    // user 气泡必须立刻出现（前端乐观插入）
    const userRow = expanded.locator('.message-row--user').filter({ hasText: content }).first();
    await expect(userRow).toBeVisible({ timeout: 10_000 });
    await screenshot(tp, 'verify-chat-step7-user-sent');

    // 记录 stop 按钮是否出现过（诊断用）
    let stopSeen = false;
    const stopWatcher = (async () => {
      const stopBtn = expanded.locator('.instance-chat-panel .chat-input__send--stop').first();
      try {
        await stopBtn.waitFor({ state: 'visible', timeout: 10_000 });
        stopSeen = true;
      } catch {
        /* 成员 Agent 可能未切 stop 态 */
      }
    })();

    // ---------- Step8 等 Agent 真回复（关键） ----------
    let replyText = '';
    let replyOk = false;
    try {
      await expect
        .poll(
          async () => {
            replyText = await expanded.evaluate((node) => {
              const rows = Array.from(node.querySelectorAll('.message-row--agent'));
              let combined = '';
              for (const row of rows) {
                const bubble = row.querySelector('.bubble--agent');
                if (!bubble) continue;
                const text = (bubble.textContent ?? '').trim();
                if (text.length > 0) combined += text;
              }
              return combined;
            });
            return replyText;
          },
          { timeout: AGENT_REPLY_TIMEOUT_MS, intervals: [500, 1_000, 2_000] },
        )
        .not.toBe('');
      replyOk = true;
    } catch (err) {
      // Step8 超时 —— 强制 dump 诊断
      await stopWatcher;

      const userVisible = await userRow.isVisible().catch(() => false);
      const stopBtnCountNow = await expanded
        .locator('.instance-chat-panel .chat-input__send--stop')
        .count()
        .catch(() => 0);
      const errorMsgs = await expanded
        .locator('.message-row--agent .bubble--agent--error, .message-row__error, .error-message')
        .allTextContents()
        .catch(() => []);
      const panelHtml = await expanded
        .locator('.instance-chat-panel')
        .first()
        .evaluate((el) => el.outerHTML.slice(0, 4000))
        .catch(() => '<capture failed>');

      // 全量 dump 到 annotations + 控制台
      const diag = {
        'user 气泡可见': userVisible,
        'stop 按钮出现过': stopSeen,
        'stop 按钮当前 count': stopBtnCountNow,
        'error 消息': errorMsgs,
        'instance-chat-panel outerHTML (前 4k)': panelHtml,
      };
      console.warn('[Step8 FAIL 诊断]', JSON.stringify(diag, null, 2));
      test.info().annotations.push({
        type: 'step8-diagnostic',
        description: JSON.stringify(diag),
      });

      await screenshot(tp, 'verify-chat-step8-fail-panel');
      throw err;
    }

    await stopWatcher;

    // ---------- Step9 成功截图留证 ----------
    expect(replyText.length).toBeGreaterThan(0);
    expect(replyOk).toBe(true);
    await screenshot(tp, 'verify-chat-step8-agent-replied');

    test.info().annotations.push({
      type: 'step8-success',
      description: `Agent 回复字符数=${replyText.length}; stop 按钮出现过=${stopSeen}; 预览="${replyText.slice(0, 80)}"`,
    });
  });
});
