// 全页面 overflow 自动审计：扫描每个窗口的所有 DOM 元素，确保只有白名单位置有滚动能力。
// 背景：用户多次反馈滚动条问题。任何在白名单外出现 overflow-y:auto/scroll 的元素都会被断言打出来。
// 零 mock、纯 CDP + DOM evaluate。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

// 白名单：允许拥有滚动能力的选择器。命中任一即豁免。
// 扩展白名单时请在 PR 描述中说明理由，避免重新长出意外滚动容器。
const ALLOWED_SELECTORS = [
  '.role-list-page__body',
  '.tsb__list',
  '.chat-list__items',
  '.chat-panel__messages',
  '.virtual-list',
  'textarea',
];

type OffenderInfo = {
  tag: string;
  className: string;
  id: string;
  overflowY: string;
  overflowX: string;
  path: string; // ancestor chain 便于定位
  rect: { w: number; h: number };
};

// 在 page 内 evaluate：收集所有 overflow-y auto/scroll 且不在白名单内的元素。
// 额外过滤：0x0 元素 / display:none 不报（getComputedStyle 在隐藏祖先下仍返回原值，用 offsetParent / rect 做可见性过滤）。
async function collectOffenders(page: Page, allowed: string[]): Promise<OffenderInfo[]> {
  return page.evaluate((allowedSelectors: string[]) => {
    const OFFENDERS: OffenderInfo[] = [];

    function describePath(el: Element): string {
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && depth < 5) {
        const tag = cur.tagName.toLowerCase();
        const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
        parts.unshift(cls ? `${tag}.${cls}` : tag);
        cur = cur.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    function isAllowed(el: Element): boolean {
      return allowedSelectors.some((sel) => el.matches(sel));
    }

    type OffenderInfo = {
      tag: string;
      className: string;
      id: string;
      overflowY: string;
      overflowX: string;
      path: string;
      rect: { w: number; h: number };
    };

    const all = document.querySelectorAll<HTMLElement>('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      const ox = cs.overflowX;
      const hasScrollY = oy === 'auto' || oy === 'scroll';
      const hasScrollX = ox === 'auto' || ox === 'scroll';
      if (!hasScrollY && !hasScrollX) continue;
      if (isAllowed(el)) continue;

      // 不可见元素跳过：0x0 / display:none 祖先
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // body / html 的 overflow 走浏览器默认，不算违规
      if (el === document.body || el === document.documentElement) continue;

      OFFENDERS.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className : '',
        id: el.id,
        overflowY: oy,
        overflowX: ox,
        path: describePath(el),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
    return OFFENDERS;
  }, allowed);
}

function formatOffenders(offenders: OffenderInfo[]): string {
  if (offenders.length === 0) return '(none)';
  return offenders
    .map((o, i) => `  [${i + 1}] <${o.tag}> #${o.id || '-'} .${o.className || '-'}`
      + ` overflow-y=${o.overflowY} overflow-x=${o.overflowX}`
      + ` ${o.rect.w}x${o.rect.h}`
      + `\n      path: ${o.path}`)
    .join('\n');
}

test.describe('overflow 全页审计', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('主窗口（胶囊 + 展开态）不得有白名单外滚动容器', async () => {
    const page = await getMainPage(browser);
    await waitMainReady(page);

    // 胶囊态
    const collapsedOffenders = await collectOffenders(page, ALLOWED_SELECTORS);
    await screenshot(page, 'overflow-audit-main-collapsed');

    // 展开态：尝试点展开（online 时才可展开；offline 就只审胶囊态）
    const logoCls = (await page.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    let expandedOffenders: OffenderInfo[] = [];
    if (logoCls.includes('logo--online')) {
      const card = page.locator('.card').first();
      if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
        await page.locator('.card__collapsed').first().click();
        await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
        await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
      }
      expandedOffenders = await collectOffenders(page, ALLOWED_SELECTORS);
      await screenshot(page, 'overflow-audit-main-expanded');
    }

    const allOffenders = [...collapsedOffenders, ...expandedOffenders];
    if (allOffenders.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[overflow-audit] main window offenders:\n${formatOffenders(allOffenders)}`);
    }
    expect(allOffenders, `意外的滚动容器（main 窗）:\n${formatOffenders(allOffenders)}`).toEqual([]);
  });

  test('roles 窗口不得有白名单外滚动容器（若可打开）', async () => {
    const mainPage = await getMainPage(browser);
    await waitMainReady(mainPage);

    // roles 窗入口：展开 → toolbar 成员面板按钮。offline 跳过。
    const logoCls = (await mainPage.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) {
      test.skip(true, 'PA 未在线，无法打开 roles 窗');
    }

    const card = mainPage.locator('.card').first();
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
    if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
      await mainPage.locator('.card__collapsed').first().click();
      await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
      await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
    }

    // 若已有 roles 窗，直接复用；没有就点按钮开。
    let rolesPage: Page | null = null;
    try {
      rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 500,
      });
    } catch {
      await mainPage.locator('.toolbar [aria-label="成员面板"]').first().click();
      rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
        timeoutMs: 5_000,
      });
    }
    await rolesPage
      .locator('.role-list-page__header')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });

    const offenders = await collectOffenders(rolesPage, ALLOWED_SELECTORS);
    await screenshot(rolesPage, 'overflow-audit-roles');
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[overflow-audit] roles window offenders:\n${formatOffenders(offenders)}`);
    }
    expect(offenders, `意外的滚动容器（roles 窗）:\n${formatOffenders(offenders)}`).toEqual([]);
  });

  test('team 窗口不得有白名单外滚动容器（若已打开）', async () => {
    // team 窗打开需要 team 存在；不强制建 team（E2E 红线：不 mock，但这里也不想造副作用）。
    // 策略：若当前 CDP 下已有 window=team，就审；否则 skip。
    let teamPage: Page | null = null;
    try {
      teamPage = await findPageByUrl(browser, (u) => u.includes('window=team'), {
        timeoutMs: 500,
      });
    } catch {
      test.skip(true, 'team 窗未打开（需要已存在 team 才审；不在本 spec 内造团队）');
    }

    const offenders = await collectOffenders(teamPage!, ALLOWED_SELECTORS);
    await screenshot(teamPage!, 'overflow-audit-team');
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[overflow-audit] team window offenders:\n${formatOffenders(offenders)}`);
    }
    expect(offenders, `意外的滚动容器（team 窗）:\n${formatOffenders(offenders)}`).toEqual([]);
  });
});
