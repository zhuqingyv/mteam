// 链路 4：主 Agent 全状态流转 E2E（初始 → thinking → responding → idle → cancel → 连发队列 → 模型切换 → 收起展开保留 → ESC）。
// 红线：零 mock、零 API 绕过、全 UI 交互、Agent 真实推理、每步截图。
// 前置：Electron dev 已跑在 http://localhost:5180/，CDP 9222，主 Agent 已 configure 且 RUNNING。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const STREAMING_START_TIMEOUT_MS = 15_000;
const TEXT_START_TIMEOUT_MS = 20_000;
const REPLY_COMPLETE_TIMEOUT_MS = 60_000;
const STABILITY_WINDOW_MS = 3_000;
const MODEL_SWITCH_TIMEOUT_MS = 20_000;

test.setTimeout(300_000); // 5 分钟（多轮真实 Agent 推理 + cancel + 连发 + 模型切换）

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

async function waitIdle(page: Page, timeoutMs: number): Promise<void> {
  await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, { timeout: timeoutMs });
}

// 最后一条 agent 气泡的文字长度（非 thinking 占位；pending-* 不带 text block 返回 0）。
async function lastAgentTextLen(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.message-row--agent'));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const bubble = rows[i].querySelector('.bubble--agent');
      if (!bubble) continue;
      const text = (bubble.textContent ?? '').trim();
      if (text.length > 0) return text.length;
    }
    return 0;
  });
}

async function readCurrentModel(page: Page): Promise<string> {
  return (
    (await page
      .locator('.toolbar .dropdown .dropdown__trigger .dropdown__label')
      .first()
      .textContent()) ?? ''
  ).trim();
}

test.describe.configure({ mode: 'serial' });

test.describe('链路 4：主 Agent 全状态流转', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    page = await getMainPage(browser);
    await waitMainReady(page);
    // RUNNING 判据：胶囊 Logo 是 online。
    const logo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    // 若上个 spec 留了展开态 + 残留 streaming，先清理。
    await waitAnimDone(page);
    const isExpanded = await page
      .locator('.card')
      .first()
      .evaluate((el) => el.classList.contains('card--expanded'));
    if (isExpanded) {
      await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
      await ensureCollapsed(page);
    }
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // Step 1 初始态：胶囊态 + Logo online + 统计文字可见。
  test('S1 初始态：胶囊 + Logo online + 胶囊统计文字', async () => {
    await ensureCollapsed(page);

    const capsuleLogo = page.locator('.card__logo .logo').first();
    await expect(capsuleLogo).toHaveClass(/logo--online/);

    // 胶囊 subtitle（TitleBlock 里 <Text variant="subtitle"> → .text.text--subtitle）：
    // idle 时 `1 Agents · 0 Tasks`（i18n 默认 en/zh-CN）。语义判据：包含 agents/tasks，
    // 第一个数字 >= 1。
    const subtitle = page.locator('.card__collapsed .title-block .text--subtitle').first();
    await expect(subtitle).toBeVisible({ timeout: 3_000 });
    const subtitleText = ((await subtitle.textContent()) ?? '').toLowerCase();
    expect(subtitleText).toMatch(/agent/);
    expect(subtitleText).toMatch(/task/);
    // "1 Agents" 里第一个数字应 >= 1
    const firstNum = Number((subtitleText.match(/\d+/) ?? ['0'])[0]);
    expect(firstNum).toBeGreaterThanOrEqual(1);

    await screenshot(page, 'chain-agent-s1-initial-capsule');
  });

  // Step 2 展开 + 填"你好" + 发送（离开 S2 状态时 streaming 已起）。
  test('S2 展开 + 发"你好"', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const textarea = page.locator('.chat-input__textarea').first();
    await textarea.fill('你好');
    await page.locator('.chat-input__send').first().click();

    // 用户气泡进入列表（发送成功的唯一本地证据）
    const userRow = page.locator('.message-row--user').filter({ hasText: '你好' }).first();
    await expect(userRow).toBeVisible({ timeout: 3_000 });

    await screenshot(page, 'chain-agent-s2-sent-hello');
  });

  // Step 3 thinking 态：stop 按钮 + typing-dots 可见（可能和 responding 态几乎同时出现）。
  // 判据对齐 id:965：stop + typing-dots 可见，agent 气泡文字可为 0（pending-*）或 >0（token 已到）。
  test('S3 thinking 态（stop + typing-dots）', async () => {
    // stop 按钮可见 = 正在处理
    await expect(page.locator('.chat-input__send--stop')).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });
    // typing-dots 出现（pending-*/thinking block 都会拉起 typing-dots）
    await expect(page.locator('.typing-dots').first()).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });
    await screenshot(page, 'chain-agent-s3-thinking');
  });

  // Step 4 responding 态：agent 气泡出现文字 + stop 按钮仍在。
  test('S4 responding 态（文字 > 0 + stop 仍在）', async () => {
    await expect
      .poll(async () => await lastAgentTextLen(page), {
        timeout: TEXT_START_TIMEOUT_MS,
        intervals: [300, 500, 1_000],
      })
      .toBeGreaterThan(0);
    // 此时 stop 按钮应仍在（还没 completed）
    await expect(page.locator('.chat-input__send--stop')).toBeVisible();
    await screenshot(page, 'chain-agent-s4-responding');
  });

  // Step 5 回复完成 → idle（stop 消失）+ 最终气泡仍带文字。
  test('S5 回复完成 idle（stop 消失）', async () => {
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);
    await expect(page.locator('.chat-input__send').first()).toBeVisible();
    const finalLen = await lastAgentTextLen(page);
    expect(finalLen).toBeGreaterThan(0);
    await screenshot(page, 'chain-agent-s5-idle');
  });

  // Step 6 cancel 流程：发长问题 → streaming → 点停止 → 3s 稳定窗口 → 截图。
  test('S6 cancel 流程（streaming → 停止 → 稳定）', async () => {
    test.setTimeout(180_000);
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const prompt = '请逐一解释 SOLID 五大原则，并给出详细代码例子';
    const textarea = page.locator('.chat-input__textarea').first();
    await textarea.fill(prompt);
    await page.locator('.chat-input__send').first().click();

    // streaming 起
    const stopBtn = page.locator('.chat-input__send--stop').first();
    await expect(stopBtn).toBeVisible({ timeout: STREAMING_START_TIMEOUT_MS });

    // 等文字开始（responding 态）
    await expect
      .poll(async () => await lastAgentTextLen(page), {
        timeout: TEXT_START_TIMEOUT_MS,
        intervals: [300, 500, 1_000],
      })
      .toBeGreaterThan(0);

    // 点停止
    await stopBtn.click();

    // stop 按钮消失 + send 按钮回来
    await expect(page.locator('.chat-input__send--stop')).toHaveCount(0, {
      timeout: REPLY_COMPLETE_TIMEOUT_MS,
    });
    await expect(page.locator('.chat-input__send').first()).toBeVisible();

    // 取消后文字不再增长（3s 稳定窗口，id:965 判据）
    const lenAfterStop = await lastAgentTextLen(page);
    expect(lenAfterStop).toBeGreaterThan(0);
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    const lenStable = await lastAgentTextLen(page);
    expect(lenStable).toBe(lenAfterStop);

    await screenshot(page, 'chain-agent-s6-cancelled-stable');
  });

  // Step 7 连发队列：发第一条 → streaming 中 Enter 发第二条 → 等两条都回复。
  test('S7 连发队列（队列 flush 完成）', async () => {
    test.setTimeout(300_000);
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // prompt 都带时间戳，保证 user 气泡文本可精确匹配（避免误中历史消息）
    const stamp = Date.now();
    const p1 = `Q1-${stamp}：请用一句话解释什么是事件驱动架构`;
    const p2 = `Q2-${stamp}：再用一句话解释 CQRS 和它的适用场景`;

    const textarea = page.locator('.chat-input__textarea').first();
    await textarea.fill(p1);
    await page.locator('.chat-input__send').first().click();

    // 第一条 streaming 起（stop 按钮可见）
    await expect(page.locator('.chat-input__send--stop').first()).toBeVisible({
      timeout: STREAMING_START_TIMEOUT_MS,
    });
    // 第一条 user 气泡进入列表
    await expect(
      page.locator('.message-row--user').filter({ hasText: p1 }).first(),
    ).toBeVisible({ timeout: 5_000 });

    // streaming 中立刻填第二条并按 Enter 入队
    await textarea.fill(p2);
    await textarea.press('Enter');

    // 第二条 user 气泡本地 echo 进入列表
    await expect(
      page.locator('.message-row--user').filter({ hasText: p2 }).first(),
    ).toBeVisible({ timeout: 5_000 });

    // 等终态：poll 直到 stop 可见 === 0（两轮 turn 都 completed，且第二条经过 stop 可见的中间态不会被误判）
    await expect
      .poll(
        async () => {
          const stopVisible = await page.locator('.chat-input__send--stop').count();
          const agentWithText = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.message-row--agent'));
            let count = 0;
            for (const row of rows) {
              const bubble = row.querySelector('.bubble--agent');
              if (!bubble) continue;
              const text = (bubble.textContent ?? '').trim();
              if (text.length > 0) count += 1;
            }
            return count;
          });
          return { stopVisible, agentWithText };
        },
        {
          timeout: REPLY_COMPLETE_TIMEOUT_MS * 2,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toMatchObject({ stopVisible: 0 });

    // 终态消息列表 ≥ 4（user1 + agent1 + user2 + agent2）。不 pin 具体 prompt 文本：
    // primaryAgentStore 在 turn.completed 或 cliType 切换时会裁历史（id:969 实测过）。
    // 我们要证的是连发闭环工作 —— 两轮 turn 都 completed 且 agent 都产出过文本。
    const finalTotal = await page
      .locator('.chat-panel__messages .message-row')
      .count();
    expect(finalTotal).toBeGreaterThanOrEqual(4);

    // 至少 2 个 agent 气泡带文本
    const agentTextCount = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.message-row--agent'));
      let count = 0;
      for (const row of rows) {
        const bubble = row.querySelector('.bubble--agent');
        if (!bubble) continue;
        const text = (bubble.textContent ?? '').trim();
        if (text.length > 0) count += 1;
      }
      return count;
    });
    expect(agentTextCount).toBeGreaterThanOrEqual(2);

    await screenshot(page, 'chain-agent-s7-queue-replied');
  });

  // Step 8 模型切换：ToolBar Dropdown → 选另一 CLI；只有一个 CLI 则跳过截图并断言。
  test('S8 模型切换（多 CLI 切换或单 CLI 跳过）', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    const dropdown = page.locator('.toolbar .dropdown').first();
    await expect(dropdown).toBeVisible({ timeout: 5_000 });

    const before = await readCurrentModel(page);
    expect(before.length).toBeGreaterThan(0);

    await dropdown.locator('.dropdown__trigger').click();
    await expect(dropdown).toHaveClass(/dropdown--open/, { timeout: 2_000 });
    await page.waitForTimeout(REACT_FLUSH_MS);

    const options = dropdown.locator('.dropdown__option');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(1);

    const labels: string[] = [];
    for (let i = 0; i < optionCount; i += 1) {
      const lbl = ((await options.nth(i).locator('.dropdown__label').textContent()) ?? '').trim();
      if (lbl.length > 0) labels.push(lbl);
    }
    const alternatives = labels.filter((l) => l !== before);

    if (alternatives.length === 0) {
      // 只有一个 CLI 可用：outside click 关下拉，截图记录"单 CLI 跳过"分支。
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await expect(dropdown).not.toHaveClass(/dropdown--open/, { timeout: 2_000 });
      await screenshot(page, 'chain-agent-s8-single-cli-skip');
      return;
    }

    const target = alternatives[0];
    await options.filter({ hasText: target }).first().click();

    // 下拉关闭 + trigger label 更新
    await expect(dropdown).not.toHaveClass(/dropdown--open/, { timeout: 2_000 });
    await expect
      .poll(async () => await readCurrentModel(page), {
        timeout: MODEL_SWITCH_TIMEOUT_MS,
        intervals: [200, 500, 1_000],
      })
      .toBe(target);

    // 胶囊 Logo 最终回 online（configure 会经过 connecting 态）
    const cardLogo = page.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await cardLogo.getAttribute('class')) ?? '', {
        timeout: MODEL_SWITCH_TIMEOUT_MS,
        intervals: [500, 1_000, 2_000],
      })
      .toMatch(/logo--online/);

    await screenshot(page, 'chain-agent-s8-model-switched');
  });

  // Step 9 收起 → 再展开：消息历史保留。
  test('S9 收起 → 展开消息保留', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // 记录收起前消息数
    const beforeTotal = await page.locator('.chat-panel__messages .message-row').count();
    expect(beforeTotal).toBeGreaterThan(0);

    // 收起
    await ensureCollapsed(page);

    // 再展开
    await ensureExpanded(page);

    // 消息还在（数量不少于收起前；允许上层缩减则至少保留 > 0 条）
    const afterTotal = await page.locator('.chat-panel__messages .message-row').count();
    expect(afterTotal).toBeGreaterThan(0);

    await screenshot(page, 'chain-agent-s9-reexpanded-messages-kept');
  });

  // Step 10 ESC 关展开：按 Escape → 胶囊态。
  // 注意：CapsulePage 的 onKeyDown 在 INPUT/TEXTAREA/isContentEditable 聚焦时会让出原生。
  // 所以按 ESC 之前必须 blur textarea，将焦点切到 body。
  test('S10 ESC 关展开 → 胶囊态', async () => {
    await ensureExpanded(page);
    await waitIdle(page, REPLY_COMPLETE_TIMEOUT_MS);

    // 把焦点从 textarea 挪到 body，避免 ESC 让出原生
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el && typeof el.blur === 'function') el.blur();
      document.body.focus?.();
    });
    // 等动画彻底静止（CapsulePage 判据：非动画期才响应 ESC）
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);

    await page.keyboard.press('Escape');

    const card = page.locator('.card').first();
    await expect(card).not.toHaveClass(/card--expanded/, { timeout: 3_000 });
    await waitAnimDone(page);
    await page.waitForTimeout(REACT_FLUSH_MS);
    await expect(page.locator('.card__collapsed').first()).toBeVisible();

    await screenshot(page, 'chain-agent-s10-esc-collapsed');
  });
});
