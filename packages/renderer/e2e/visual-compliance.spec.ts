// 审美截图 + 组件库合规自动扫描。
// 背景：renderer/.claude/CLAUDE.md 铁律要求 0 裸 SVG / 0 自研 button。
// 本 spec 用 CDP 附到正在跑的 Electron，evaluate 扫全页 DOM 抓违规 + 逐窗截图留证。
// 零 mock、零副作用（只读 + 必要的导航点击，不建 team 不改数据）。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

// ---- 扫描工具 ----

type RawOffender = {
  tag: string;
  className: string;
  id: string;
  ariaLabel: string;
  path: string;
  rect: { w: number; h: number };
};

async function collectRawSvgs(page: Page): Promise<RawOffender[]> {
  return page.evaluate(() => {
    function describePath(el: Element): string {
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && depth < 6) {
        const tag = cur.tagName.toLowerCase();
        const cls =
          typeof cur.className === 'string'
            ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
            : typeof (cur as SVGElement).className === 'object'
              ? String((cur as SVGElement).getAttribute('class') ?? '')
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .join('.')
              : '';
        parts.unshift(cls ? `${tag}.${cls}` : tag);
        cur = cur.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    const out: RawOffender[] = [];
    // svg 根节点没有 .icon class = 裸 SVG（没走 Icon atom）。
    const svgs = document.querySelectorAll<SVGSVGElement>('svg:not(.icon)');
    for (const el of svgs) {
      const rect = el.getBoundingClientRect();
      const classAttr = String(el.getAttribute('class') ?? '');
      out.push({
        tag: 'svg',
        className: classAttr,
        id: el.id,
        ariaLabel: el.getAttribute('aria-label') ?? '',
        path: describePath(el),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
    return out;
  });
}

async function collectRawButtons(page: Page): Promise<RawOffender[]> {
  return page.evaluate(() => {
    function describePath(el: Element): string {
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && depth < 6) {
        const tag = cur.tagName.toLowerCase();
        const cls = typeof cur.className === 'string'
          ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
          : '';
        parts.unshift(cls ? `${tag}.${cls}` : tag);
        cur = cur.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    const out: RawOffender[] = [];
    // button:not(.btn) = 没走 Button atom 的裸 button。
    // 注意：div[role="button"] 不会被这个选择器命中（不是 <button> 标签），天然豁免，无需白名单过滤。
    const btns = document.querySelectorAll<HTMLButtonElement>('button:not(.btn)');
    for (const el of btns) {
      const rect = el.getBoundingClientRect();
      out.push({
        tag: 'button',
        className: typeof el.className === 'string' ? el.className : '',
        id: el.id,
        ariaLabel: el.getAttribute('aria-label') ?? '',
        path: describePath(el),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
    return out;
  });
}

function formatOffenders(list: RawOffender[]): string {
  if (list.length === 0) return '(none)';
  return list
    .map(
      (o, i) =>
        `  [${i + 1}] <${o.tag}> #${o.id || '-'} .${o.className || '-'}` +
        ` aria-label="${o.ariaLabel || '-'}" ${o.rect.w}x${o.rect.h}` +
        `\n      path: ${o.path}`,
    )
    .join('\n');
}

async function ensureExpanded(main: Page): Promise<void> {
  const card = main.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await main.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function openRolesWindow(browser: Browser, main: Page): Promise<Page | null> {
  const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
  if (!logoCls.includes('logo--online')) return null;
  await ensureExpanded(main);
  try {
    return await findPageByUrl(browser, (u) => u.includes('window=roles'), { timeoutMs: 500 });
  } catch {
    await main.locator('.toolbar [aria-label="成员面板"]').first().click();
    return findPageByUrl(browser, (u) => u.includes('window=roles'), { timeoutMs: 5_000 });
  }
}

async function openSettingsWindow(browser: Browser, main: Page): Promise<Page> {
  try {
    return await findPageByUrl(browser, (u) => u.includes('window=settings'), { timeoutMs: 500 });
  } catch {
    await ensureExpanded(main);
    await main.locator('.toolbar [aria-label="设置"]').first().click();
    return findPageByUrl(browser, (u) => u.includes('window=settings'), { timeoutMs: 5_000 });
  }
}

// ---- Tests ----

test.describe('visual-compliance：审美截图 + 组件库合规扫描', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('TC-1 组件库合规扫描：0 裸 SVG（svg:not(.icon)）', async () => {
    const main = await getMainPage(browser);
    await waitMainReady(main);

    // 胶囊态先扫
    const mainCollapsed = await collectRawSvgs(main);
    await screenshot(main, 'compliance-svg-main-collapsed');

    // 展开态（若在线）再扫
    let mainExpanded: RawOffender[] = [];
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (logoCls.includes('logo--online')) {
      await ensureExpanded(main);
      mainExpanded = await collectRawSvgs(main);
      await screenshot(main, 'compliance-svg-main-expanded');
    }

    // roles 窗（若可开）
    let rolesOffenders: RawOffender[] = [];
    const rolesPage = await openRolesWindow(browser, main);
    if (rolesPage) {
      await rolesPage
        .locator('.role-list-page__header')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 });
      rolesOffenders = await collectRawSvgs(rolesPage);
      await screenshot(rolesPage, 'compliance-svg-roles');
    }

    const all = [
      ...mainCollapsed.map((o) => ({ ...o, window: 'main(collapsed)' })),
      ...mainExpanded.map((o) => ({ ...o, window: 'main(expanded)' })),
      ...rolesOffenders.map((o) => ({ ...o, window: 'roles' })),
    ];
    if (all.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[compliance] 裸 SVG 违规:\n${formatOffenders(all)}`);
    }
    expect(all, `出现裸 SVG（应走 <Icon name="..." /> atom）:\n${formatOffenders(all)}`).toEqual(
      [],
    );
  });

  test('TC-2 组件库合规扫描：0 裸 button（button:not(.btn)）', async () => {
    const main = await getMainPage(browser);
    await waitMainReady(main);

    const mainCollapsed = await collectRawButtons(main);
    await screenshot(main, 'compliance-btn-main-collapsed');

    let mainExpanded: RawOffender[] = [];
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (logoCls.includes('logo--online')) {
      await ensureExpanded(main);
      mainExpanded = await collectRawButtons(main);
      await screenshot(main, 'compliance-btn-main-expanded');
    }

    let rolesOffenders: RawOffender[] = [];
    const rolesPage = await openRolesWindow(browser, main);
    if (rolesPage) {
      await rolesPage
        .locator('.role-list-page__header')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 });
      rolesOffenders = await collectRawButtons(rolesPage);
      await screenshot(rolesPage, 'compliance-btn-roles');
    }

    const all = [
      ...mainCollapsed.map((o) => ({ ...o, window: 'main(collapsed)' })),
      ...mainExpanded.map((o) => ({ ...o, window: 'main(expanded)' })),
      ...rolesOffenders.map((o) => ({ ...o, window: 'roles' })),
    ];
    if (all.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[compliance] 裸 button 违规:\n${formatOffenders(all)}`);
    }
    expect(all, `出现裸 button（应走 <Button ... /> atom）:\n${formatOffenders(all)}`).toEqual([]);
  });

  test('TC-3 审美截图：每页全屏留证', async () => {
    const main = await getMainPage(browser);
    await waitMainReady(main);

    // 胶囊态：先主动收起（可能被之前的 test 展开）
    const card = main.locator('.card').first();
    if (await card.evaluate((el) => el.classList.contains('card--expanded'))) {
      // 不点 collapsed 收起按钮（那是个触发展开的），走最小化 / 重新加载保证胶囊态难以保证
      // 更稳的方式：展开态下 `.card__minimize` 或 `.card__collapsed-trigger` 等触发收起。
      // 但不同版本差异大，直接按现状截图更诚实，命名保留意图。
    }
    await screenshot(main, 'visual-capsule');

    // 展开态
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (logoCls.includes('logo--online')) {
      await ensureExpanded(main);
      // 等动画结束再截，避免糊屏
      await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
      await screenshot(main, 'visual-expanded');
    } else {
      // 离线：用胶囊态复用为展开态占位，保留文件命名但标明离线
      await screenshot(main, 'visual-expanded-offline-fallback');
    }

    // roles 窗
    const rolesPage = await openRolesWindow(browser, main);
    if (rolesPage) {
      await rolesPage
        .locator('.role-list-page__header')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 });
      await screenshot(rolesPage, 'visual-roles');
    }

    // settings 窗
    try {
      const settingsPage = await openSettingsWindow(browser, main);
      await settingsPage.waitForLoadState('domcontentloaded');
      // 等到有 body / 主要节点出现再截，避免白屏
      await settingsPage.locator('body').waitFor({ state: 'visible', timeout: 5_000 });
      await screenshot(settingsPage, 'visual-settings');
    } catch (e) {
      // 设置窗打开失败不阻塞本 spec，打日志即可
      // eslint-disable-next-line no-console
      console.log(`[visual] settings 窗未打开: ${(e as Error).message}`);
    }

    // team 窗：不主动建 team（避免副作用），只在已打开时截
    try {
      const teamPage = await findPageByUrl(browser, (u) => u.includes('window=team'), {
        timeoutMs: 500,
      });
      await screenshot(teamPage, 'visual-team');
    } catch {
      // 没 team 窗就跳过 team 截图
    }
  });

  test('TC-4 i18n 卫生：aria-label 不出现 undefined/null/[object Object]', async () => {
    const main = await getMainPage(browser);
    await waitMainReady(main);

    type LabelInfo = { label: string; tag: string; path: string };

    const collect = async (page: Page): Promise<LabelInfo[]> => {
      return page.evaluate(() => {
        function describePath(el: Element): string {
          const parts: string[] = [];
          let cur: Element | null = el;
          let depth = 0;
          while (cur && depth < 4) {
            const tag = cur.tagName.toLowerCase();
            const cls =
              typeof cur.className === 'string'
                ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
                : '';
            parts.unshift(cls ? `${tag}.${cls}` : tag);
            cur = cur.parentElement;
            depth += 1;
          }
          return parts.join(' > ');
        }
        const out: { label: string; tag: string; path: string }[] = [];
        const all = document.querySelectorAll<HTMLElement>('[aria-label]');
        for (const el of all) {
          out.push({
            label: el.getAttribute('aria-label') ?? '',
            tag: el.tagName.toLowerCase(),
            path: describePath(el),
          });
        }
        return out;
      });
    };

    const BAD = ['undefined', 'null', '[object Object]'];

    const checkBatch = (labels: LabelInfo[], windowName: string) =>
      labels
        .filter((l) => BAD.some((b) => l.label.toLowerCase().includes(b.toLowerCase())))
        .map((l) => ({ ...l, window: windowName }));

    const mainBad = checkBatch(await collect(main), 'main');
    await screenshot(main, 'compliance-i18n-main');

    let rolesBad: ReturnType<typeof checkBatch> = [];
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (logoCls.includes('logo--online')) {
      await ensureExpanded(main);
      mainBad.push(...checkBatch(await collect(main), 'main(expanded)'));
      const rolesPage = await openRolesWindow(browser, main);
      if (rolesPage) {
        await rolesPage
          .locator('.role-list-page__header')
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 });
        rolesBad = checkBatch(await collect(rolesPage), 'roles');
        await screenshot(rolesPage, 'compliance-i18n-roles');
      }
    }

    const all = [...mainBad, ...rolesBad];
    if (all.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[compliance] 异常 aria-label:\n${all
          .map(
            (l, i) =>
              `  [${i + 1}] window=${l.window} <${l.tag}> aria-label="${l.label}"\n      path: ${l.path}`,
          )
          .join('\n')}`,
      );
    }
    expect(
      all,
      `aria-label 含 undefined/null/[object Object]（i18n 键缺失或对象未格式化）`,
    ).toEqual([]);
  });
});
