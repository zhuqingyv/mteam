// Phase 4 Wave 1B — 主 Agent 创建 leader + teamCanvas 自动唤起 E2E。
//
// 场景清单：
//   P4-S1: 胶囊展开 → 输入框发送 → messageStore.byInstance[primaryId] 有 user 消息
//   P4-S2: HTTP 直调 create leader+team → teamStore.teams 长度 +1
//   P4-S3: 团队面板打开 → 画布出现 leader 的 CanvasNode（data-instance-id 匹配）
//
// 前置：Electron dev 已跑 CDP 9222；PA（主 Agent）已配置并 online；
//       另一路任务已在 renderer 暴露 window.__messageStore / __teamStore。
// 注意：React 18 setState flush 约 150~200ms，发 prompt 后统一 wait 200ms 再读 store。
import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectElectron, getMainPage, waitMainReady, screenshot } from './cdp-helpers';
import {
  API_BASE,
  cleanTeams,
  createLeader,
  findTeamPage,
  uniqueName,
  waitForStoreState,
} from './phase4-helpers';

const REACT_FLUSH_MS = 200;

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function ensureCollapsed(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
    await page.locator('.card__close .btn').first().click();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

// 确保有至少一个可用于 leader 的模板。返回模板名。
async function ensureTemplate(page: Page): Promise<string> {
  const listResp = await page.request.get(`${API_BASE}/api/panel/templates`);
  if (listResp.ok()) {
    const list = (await listResp.json()) as Array<{ name: string }>;
    if (list.length > 0) return list[0].name;
  }
  const name = uniqueName('p4tpl');
  const resp = await page.request.post(`${API_BASE}/api/panel/templates`, {
    data: { name, role: 'tester' },
  });
  if (!resp.ok()) throw new Error(`seed template failed: ${resp.status()} ${await resp.text()}`);
  return name;
}

// 关团队窗口（下一条 test 重新打开，避免残留）。
async function closeTeamWindowIfOpen(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('window=team')) await p.close().catch(() => {});
    }
  }
}

test.describe('P4-S1 胶囊展开 + 发送消息 → messageStore', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    const logoCls = (await page.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，无法发送消息');
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('展开胶囊 → 发消息 → byInstance[primary] 出现 user 消息或 pendingPrompt', async () => {
    await ensureExpanded(page);

    // 读主 Agent id（走 panel forwarder）。
    const paResp = await page.request.get(`${API_BASE}/api/panel/primary-agent`);
    expect(paResp.ok()).toBeTruthy();
    const pa = (await paResp.json()) as { id?: string } | null;
    if (!pa?.id) test.skip(true, 'primary agent 未配置');
    const primaryId = pa!.id!;

    const content = `p4s1-${Date.now()}`;
    await page.locator('.chat-input__textarea').first().fill(content);
    await page.locator('.chat-input__send').first().click();

    // 用户气泡立刻出现 — DOM 侧证据。
    await expect(
      page.locator('.message-row--user').filter({ hasText: content }).first(),
    ).toBeVisible({ timeout: 3_000 });

    // React 18 flush 后读 store。
    await page.waitForTimeout(REACT_FLUSH_MS);
    const stored = await waitForStoreState<{ hasPrompt: boolean; hasMsg: boolean }>(
      page,
      `(() => {
        const s = window.__messageStore && window.__messageStore.getState
          ? window.__messageStore.getState()
          : null;
        if (!s) return null;
        const bucket = s.byInstance && s.byInstance[${JSON.stringify(primaryId)}];
        if (!bucket) return null;
        const hasPrompt = (bucket.pendingPrompts || []).some((p) => p === ${JSON.stringify(content)});
        const hasMsg = (bucket.messages || []).some((m) => {
          if (!m) return false;
          if (m.text === ${JSON.stringify(content)}) return true;
          const blocks = Array.isArray(m.blocks) ? m.blocks : [];
          return blocks.some((b) => b && b.type === 'text' && b.text === ${JSON.stringify(content)});
        });
        return (hasPrompt || hasMsg) ? { hasPrompt, hasMsg } : null;
      })()`,
      4_000,
    );
    expect(stored.hasPrompt || stored.hasMsg).toBe(true);

    await screenshot(page, 'p4-s1-messagestore');
  });
});

test.describe('P4-S2 HTTP create leader → teamStore.teams +1', () => {
  let browser: Browser;
  let page: Page;
  let templateName: string;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    templateName = await ensureTemplate(page);
    await cleanTeams(page);
  });

  test.afterAll(async () => {
    await cleanTeams(page);
    await browser.close();
  });

  test('POST /api/panel/instances + POST /api/panel/teams → teamStore.teams 含新 team', async () => {
    // 读当前 teams 长度（DOM 侧 truth；WS 推送会写入 store）。
    const beforeLen = await page.evaluate(() => {
      const s = (window as any).__teamStore?.getState?.();
      return s ? (s.teams?.length ?? 0) : 0;
    });

    const leader = await createLeader(page, { templateName });

    // WS 事件 team.created 经 bus→ws→store 链路，React 18 flush 再 poll。
    await page.waitForTimeout(REACT_FLUSH_MS);

    await waitForStoreState(
      page,
      `(() => {
        const s = window.__teamStore && window.__teamStore.getState
          ? window.__teamStore.getState()
          : null;
        if (!s) return null;
        const hit = (s.teams || []).find((t) => t.id === ${JSON.stringify(leader.teamId)});
        return hit ? true : null;
      })()`,
      5_000,
    );

    const afterLen = await page.evaluate(() => {
      const s = (window as any).__teamStore?.getState?.();
      return s ? (s.teams?.length ?? 0) : 0;
    });
    expect(afterLen).toBe(beforeLen + 1);
  });
});

test.describe('P4-S3 团队面板打开 → 画布 CanvasNode 数量', () => {
  let browser: Browser;
  let page: Page;
  let templateName: string;
  let leaderInstanceId: string | null = null;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    templateName = await ensureTemplate(page);
    await closeTeamWindowIfOpen(browser);
    await cleanTeams(page);
  });

  test.afterAll(async () => {
    await closeTeamWindowIfOpen(browser);
    await cleanTeams(page);
    await browser.close();
  });

  test('建 leader team 后点成员面板 → 团队窗出现 data-instance-id 节点', async () => {
    const leader = await createLeader(page, { templateName });
    leaderInstanceId = leader.instanceId;

    await ensureExpanded(page);
    await page.locator('.toolbar [aria-label="成员面板"]').first().click();

    const teamPage = await findTeamPage(browser, 5_000);
    await teamPage.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    // React 18 flush + WS snapshot 推完。
    await teamPage.waitForTimeout(REACT_FLUSH_MS);

    // 至少出现一个节点，且其中一个 data-instance-id === leader.instanceId。
    const leaderNode = teamPage.locator(
      `.canvas-node[data-instance-id="${leader.instanceId}"]`,
    );
    await expect(leaderNode).toBeVisible({ timeout: 5_000 });

    const nodes = teamPage.locator('.canvas-node[data-instance-id]');
    const count = await nodes.count();
    expect(count).toBeGreaterThanOrEqual(1);

    await screenshot(teamPage, 'p4-s3-canvas-nodes');

    await ensureCollapsed(page).catch(() => {});
  });

  test.afterEach(async () => {
    // 单测内部 teamId 已清，instance 留给级联清理；如需显式 force 删 instance 再加。
    if (leaderInstanceId) {
      await page.request.delete(
        `${API_BASE}/api/panel/instances/${encodeURIComponent(leaderInstanceId)}?force=1`,
      );
      leaderInstanceId = null;
    }
  });
});
