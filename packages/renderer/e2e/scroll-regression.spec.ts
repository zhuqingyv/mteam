// 成员列表滚动回归 E2E。
// 用户反馈：roles 窗口成员列表滚动不了。这条 spec 守住 "容器能滚" 这件事。
//
// 红线：零 mock、零 API 绕过 UI、所有入口通过 UI 交互打开。
// 前置：Electron dev 已跑，CDP 9222；主 Agent RUNNING。
//
// 真实 DOM 结构（见 src/pages/RoleListPage.{tsx,css}）：
//   .role-list-page          overflow-y: auto   <- 真正的滚动容器
//   └─ .role-list-page__body                    <- 内容区，不是滚动容器
// 任务文案指向 __body，但 __body 没有 overflow 规则。为守住"能滚"这件事，我们
// 以 __body 为起点向外找第一个 overflow-y=auto|scroll 的祖先作为滚动容器，兼容
// 两种布局（内层滚 or 外层滚）。断言围绕"滚动容器的 scrollTop 能被改变"展开。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

const REACT_FLUSH_MS = 200;

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

test.describe.configure({ mode: 'serial' });

test.describe('成员列表滚动回归', () => {
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
    await ensureCollapsed(page);
  });

  test.afterAll(async () => {
    await closeAuxWindows(browser);
    await browser.close();
  });

  test('roles 窗口成员列表容器可滚动', async () => {
    // 打开 roles 窗口：胶囊 → ToolBar 成员面板按钮。
    await closeAuxWindows(browser);
    await ensureExpanded(page);
    await page.locator('.toolbar [aria-label="成员面板"]').first().click();

    const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
      timeoutMs: 5_000,
    });
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });

    // 等成员卡片渲染（loading 态会只显示 "加载中…"，没有 __cell）
    await rolesPage
      .locator('.worker-list-panel__cell')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
    await rolesPage.waitForTimeout(REACT_FLUSH_MS);

    // 从 __body 起向上找第一个 overflow-y=auto|scroll 的祖先作为滚动容器。
    // 如果 body 自身就是滚动容器也会命中自己。
    const scrollInfo = await rolesPage.evaluate(() => {
      const body = document.querySelector('.role-list-page__body') as HTMLElement | null;
      if (!body) return { found: false as const };
      let node: HTMLElement | null = body;
      while (node) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY)) {
          return {
            found: true as const,
            selector: Array.from(node.classList)
              .map((c) => `.${c}`)
              .join(''),
            scrollTop: node.scrollTop,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            tag: node.tagName.toLowerCase(),
            overflowY: cs.overflowY,
          };
        }
        node = node.parentElement;
      }
      return { found: false as const };
    });

    expect(scrollInfo.found, 'roles 窗口必须存在一个 overflow-y 可滚的容器（__body 或其祖先）').toBe(
      true,
    );
    if (!scrollInfo.found) return; // 类型守卫

    // 成员数低于门槛（内容不超出）则此断言本身没意义，直接失败并点出原因，
    // 不要把"没数据"伪装成"能滚"。
    const cellCount = await rolesPage.locator('.worker-list-panel__cell').count();
    expect(
      scrollInfo.scrollHeight,
      `成员数=${cellCount}，内容未超出容器（scrollHeight=${scrollInfo.scrollHeight} <= clientHeight=${scrollInfo.clientHeight}）。无法验证"能滚" — 请先让当前 roles 窗口有足够成员，或手动扩充 fixture。`,
    ).toBeGreaterThan(scrollInfo.clientHeight);

    // 初始 scrollTop = 0
    expect(scrollInfo.scrollTop).toBe(0);

    // 用 DOM 直接驱动 scrollTop（合法：这里测的是容器"有没有滚动能力"，不是
    // "用户滚动手势映射到 scrollTop"）。需要重新查询节点，因为上面 evaluate
    // 返回的是序列化后的值。
    const sel = scrollInfo.selector;
    const afterTop = await rolesPage.evaluate((selector) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return -1;
      el.scrollTop = 200;
      return el.scrollTop;
    }, sel);

    // scrollTop 能被实际写入（浏览器会 clamp 到 [0, scrollHeight-clientHeight]，但
    // 在上面断言了 scrollHeight > clientHeight，所以这里必然 > 0）。
    expect(afterTop).toBeGreaterThan(0);

    await screenshot(rolesPage, 'scroll-regression-roles-scrolled');
  });
});
