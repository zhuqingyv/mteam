// 链路 2：模板 CRUD 全链路 E2E — 一个 test 串 7 步。
//
// 红线：零 mock、零 API 绕过 UI、全部经真实 UI 交互。
// 前置：Electron dev 跑起来 + CDP 9222 + 主 Agent RUNNING。
//
// 7 步串行：
//   1. 展开胶囊 → 点成员面板按钮 → roles 窗口打开
//   2. 点"新建成员" → Modal → 填名称/角色 → 保存 → Modal 关闭
//   3. 关 roles 重开 → 搜索链路名 → 断言卡片出现
//      （workerStore 设计缺陷：关窗重开走 useWorkers mount 重新 get_workers，见 mnemo id:1005）
//   4. 打开 settings → 模板管理 tab → 找到模板 → 点编辑
//   5. 改描述 → 保存 → Modal 关闭
//   6. 找到同模板 → 点删除 → ConfirmDialog 确认 → 断言卡消失
//      （SettingsPage 删除后不本地同步，见 mnemo id:1014；关窗重开后端已删）
//   7. 关 settings → 重开 roles → 搜索链路名 → 断言卡片消失
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

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await waitAnimDone(page);
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await waitAnimDone(page);
  }
}

async function closePanelIfOpen(browser: Browser, token: string): Promise<void> {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(token)) {
        await p.close().catch(() => {});
      }
    }
  }
}

async function openRolesWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();
  const rolesPage = await findPageByUrl(browser, (u) => u.includes('window=roles'), {
    timeoutMs: 5_000,
  });
  await rolesPage
    .locator('.role-list-page')
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });
  return rolesPage;
}

async function openSettingsWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="设置"]').first().click();
  const settings = await findPageByUrl(browser, (u) => u.includes('window=settings'), {
    timeoutMs: 5_000,
  });
  await settings.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
  return settings;
}

test.describe.configure({ mode: 'serial' });

test.describe('链路 2：模板 CRUD 全链路', () => {
  let browser: Browser;
  let main: Page;
  const ts = Date.now();
  const memberName = `链路测试-${ts}`;
  const searchKey = '链路测试';

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    const logo = main.locator('.card__logo .logo').first();
    await expect
      .poll(async () => (await logo.getAttribute('class')) ?? '', { timeout: 10_000 })
      .toMatch(/logo--online/);
    await closePanelIfOpen(browser, 'window=roles');
    await closePanelIfOpen(browser, 'window=settings');
  });

  test.afterAll(async () => {
    await closePanelIfOpen(browser, 'window=roles');
    await closePanelIfOpen(browser, 'window=settings');
    await browser.close();
  });

  test('链路 2：创建 → 验证 → 编辑 → 删除 → 验证消失', async () => {
    // ───────── 步 1：打开 roles 窗口 ─────────
    let roles = await openRolesWindow(browser, main);
    // 先清搜索框，保证 01 截图显示全量员工而非过滤态
    await roles.locator('.role-list-page__search .input__field').first().fill('');
    await roles.waitForTimeout(REACT_FLUSH_MS);
    await roles.bringToFront();
    await screenshot(roles, 'chain-tpl-crud-01-roles-opened');

    // ───────── 步 2：新建成员 ─────────
    await roles.getByRole('button', { name: /新建成员/ }).click();
    const createModal = roles.locator('.modal').first();
    await expect(createModal).toBeVisible({ timeout: 3_000 });
    await expect(createModal.locator('.tpl-editor')).toBeVisible();

    // TemplateEditor: name placeholder 'frontend-engineer'，role placeholder 'engineer'
    await createModal.locator('input[placeholder="frontend-engineer"]').first().fill(memberName);
    await createModal.locator('input[placeholder="engineer"]').first().fill('tester');
    await roles.bringToFront();
    await screenshot(roles, 'chain-tpl-crud-02-create-modal-filled');

    const createSave = createModal.getByRole('button', { name: /^保存$/ }).first();
    await expect(createSave).toBeEnabled();
    await createSave.click();
    await expect(createModal).toBeHidden({ timeout: 5_000 });

    // ───────── 步 3：关 roles 重开 → 搜索 → 断言卡片出现 ─────────
    // workerStore.upsertByName 设计缺陷（mnemo id:1005）：新模板创建当前窗口不自动长卡，
    // 关窗再打开走 useWorkers mount 重新 get_workers 拉全量。纯 UI 路径，不走 API。
    await closePanelIfOpen(browser, 'window=roles');
    roles = await openRolesWindow(browser, main);

    const rolesSearch = roles.locator('.role-list-page__search .input__field').first();
    await rolesSearch.fill(searchKey);
    await roles.waitForTimeout(REACT_FLUSH_MS);

    const createdCard = roles.locator(`[aria-label="${memberName} 员工卡片"]`);
    await expect(createdCard).toBeVisible({ timeout: 8_000 });
    // 列表里同名前缀"链路测试-"可能有多张历史残留，把新卡滚入视口再拍截图，保证人眼能核验
    await createdCard.scrollIntoViewIfNeeded();
    await roles.waitForTimeout(REACT_FLUSH_MS);
    await roles.bringToFront();
    await screenshot(roles, 'chain-tpl-crud-03-verify-created');

    // ───────── 步 4：打开 settings → 模板管理 tab → 找到模板 → 点编辑 ─────────
    const settings = await openSettingsWindow(browser, main);
    await settings.getByRole('button', { name: /^模板管理$/ }).click();

    // SettingsPage 独立 BrowserWindow（独立 templateStore 实例），mount 时 listTemplates HTTP 拉全量。
    // 需要等 HTTP 返回并渲染。列表可能很长，卡片不在视口里，先等挂载（attached）再滚入视野。
    const targetCard = settings
      .locator('.tpl-list__card')
      .filter({ hasText: memberName })
      .first();
    await expect
      .poll(async () => targetCard.count(), { timeout: 8_000 })
      .toBeGreaterThan(0);
    await targetCard.scrollIntoViewIfNeeded();
    await expect(targetCard).toBeVisible({ timeout: 3_000 });
    await settings.bringToFront();
    await screenshot(settings, 'chain-tpl-crud-04-settings-template-found');

    await targetCard.getByRole('button', { name: /^编辑$/ }).click();

    const editModal = settings.locator('.modal').first();
    await expect(editModal).toBeVisible({ timeout: 3_000 });
    await expect(editModal.locator('.tpl-editor')).toBeVisible();

    // ───────── 步 5：改描述 → 保存 → Modal 关闭 ─────────
    const descInput = editModal
      .locator('input[placeholder="用一句话描述角色职责"]')
      .first();
    await expect(descInput).toBeVisible();
    const newDesc = `E2E 链路修改 ${ts}`;
    await descInput.fill(newDesc);
    await settings.bringToFront();
    await screenshot(settings, 'chain-tpl-crud-05-edit-filled');

    const editSave = editModal.getByRole('button', { name: /^保存$/ }).first();
    await expect(editSave).toBeEnabled();
    await editSave.click();
    await expect(editModal).toBeHidden({ timeout: 5_000 });

    // ───────── 步 6：删除模板 → 确认 → 列表消失 ─────────
    // 改完后重新定位同一张卡
    const toDelete = settings
      .locator('.tpl-list__card')
      .filter({ hasText: memberName })
      .first();
    await expect
      .poll(async () => toDelete.count(), { timeout: 5_000 })
      .toBeGreaterThan(0);
    await toDelete.scrollIntoViewIfNeeded();
    await expect(toDelete).toBeVisible({ timeout: 3_000 });
    await toDelete.getByRole('button', { name: /^删除$/ }).click();

    const confirm = settings.locator('.confirm-dialog').first();
    await expect(confirm).toBeVisible({ timeout: 3_000 });
    await expect(confirm).toContainText(memberName);
    await settings.bringToFront();
    await screenshot(settings, 'chain-tpl-crud-06-delete-confirm');

    // ConfirmDialog 里的"删除"按钮 primary
    await confirm.getByRole('button', { name: /^删除$/ }).click();
    await expect(confirm).toBeHidden({ timeout: 5_000 });

    // ───────── 步 7：回 roles 验证 ─────────
    // SettingsPage 删除后没有本地 removeTemplate 同步（mnemo id:1014）；
    // 关 settings 重开 roles 走 useWorkers mount 重新 get_workers，断言后端已删。
    await closePanelIfOpen(browser, 'window=settings');
    await closePanelIfOpen(browser, 'window=roles');

    const rolesReopen = await openRolesWindow(browser, main);
    const reopenSearch = rolesReopen
      .locator('.role-list-page__search .input__field')
      .first();
    await reopenSearch.fill(searchKey);
    await rolesReopen.waitForTimeout(REACT_FLUSH_MS);

    // 卡片应消失（worker 条目在 worker.status_changed 推送里同步删除，
    // 或下一轮 get_workers 全量覆盖不含该条）。
    await expect
      .poll(
        async () =>
          rolesReopen.locator(`[aria-label="${memberName} 员工卡片"]`).count(),
        { timeout: 8_000 },
      )
      .toBe(0);

    await rolesReopen.bringToFront();
    await screenshot(rolesReopen, 'chain-tpl-crud-07-verify-deleted');
  });
});
