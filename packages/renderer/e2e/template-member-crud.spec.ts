// 设置页模板 CRUD + 角色列表页新建成员 E2E。
// 强制真实 Electron CDP，不 mock、不绕 UI。
//
// TC-1 新建成员：主窗口展开 → 点成员面板按钮 → roles 窗口 → 点"新建成员" → 填 name/role → 保存 → Modal 关闭 + 列表出现。
// TC-2 编辑模板：主窗口展开 → 点设置按钮 → settings 窗口 → 切模板管理 tab → 编辑第一个 → 改描述 → 保存 → Modal 关闭。
// TC-3 删除成员：UI 当前无"成员删除"入口（WorkerCard 更多菜单只有查看详情/工作统计，
//   useWorkersPage 也没 delete action），等 team-lead 裁决是否改到设置页模板列表。占位 fixme。
import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  connectElectron,
  getMainPage,
  waitMainReady,
  findPageByUrl,
  screenshot,
} from './cdp-helpers';

async function ensureExpanded(page: Page): Promise<void> {
  const card = page.locator('.card').first();
  await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  if (!(await card.evaluate((el) => el.classList.contains('card--expanded')))) {
    await page.locator('.card__collapsed').first().click();
    await expect(card).toHaveClass(/card--expanded/, { timeout: 2_000 });
    await expect(card).not.toHaveClass(/card--animating/, { timeout: 2_000 });
  }
}

async function openRolesWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  // ToolBar 里 aria-label="成员面板"（i18n key: toolbar.team_panel）触发 openRoleList。
  await main.locator('.toolbar [aria-label="成员面板"]').first().click();
  return findPageByUrl(browser, (u) => u.includes('window=roles'), { timeoutMs: 5_000 });
}

async function openSettingsWindow(browser: Browser, main: Page): Promise<Page> {
  await ensureExpanded(main);
  await main.locator('.toolbar [aria-label="设置"]').first().click();
  return findPageByUrl(browser, (u) => u.includes('window=settings'), { timeoutMs: 5_000 });
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

test.describe('P2 模板 CRUD + 新建成员', () => {
  let browser: Browser;
  let main: Page;
  const createdMemberName = `测试员-${Date.now()}`;
  // TC-2 创建、TC-3 删除的合规模板名；TC-2 给它赋值，TC-3 读它。
  let tc2TemplateName = '';

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    main = await getMainPage(browser);
    await waitMainReady(main);
    const logoCls = (await main.locator('.card__logo .logo').first().getAttribute('class')) ?? '';
    if (!logoCls.includes('logo--online')) test.skip(true, 'PA 未在线，无法展开');
  });

  test.afterAll(async () => {
    await closePanelIfOpen(browser, 'window=roles');
    await closePanelIfOpen(browser, 'window=settings');
    await browser.close();
  });

  test.beforeEach(async () => {
    await closePanelIfOpen(browser, 'window=roles');
    await closePanelIfOpen(browser, 'window=settings');
  });

  test('TC-1 新建成员：roles 窗口 → Modal → 填写 → 保存 → 列表出现', async () => {
    const roles = await openRolesWindow(browser, main);
    await roles.locator('.role-list-page').waitFor({ state: 'visible', timeout: 5_000 });

    // 点右上角"新建成员"按钮（Button primary 内带 Icon+span"新建成员"）。
    await roles.getByRole('button', { name: /新建成员/ }).click();

    // Modal 弹出：TemplateEditor 的根类是 .tpl-editor，Modal 根是 .modal。
    const modal = roles.locator('.modal').first();
    await expect(modal).toBeVisible({ timeout: 3_000 });
    await expect(modal.locator('.tpl-editor')).toBeVisible();

    // TemplateEditor 的 Input 是 atom，placeholder 区分字段。
    // name 字段：placeholder 'frontend-engineer'；role：'engineer'。
    const nameInput = modal.locator('input[placeholder="frontend-engineer"]').first();
    const roleInput = modal.locator('input[placeholder="engineer"]').first();
    await nameInput.fill(createdMemberName);
    await roleInput.fill('tester');

    await screenshot(roles, 'p2-tc1-member-modal-filled');

    // 保存按钮：primary variant，label = "保存"。
    const saveBtn = modal.getByRole('button', { name: /^保存$/ }).first();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // 断言 Modal 关闭。
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // workerStore 只监听 worker.status_changed（对已存在 name 做 upsert），
    // 新模板创建后当前 roles 窗口不会自动拉取新的 worker 条目。
    // 重新打开窗口触发 useWorkers 重新 get_workers，让新成员进入 DOM —
    // 这是纯 UI 路径，不走 API。
    await closePanelIfOpen(browser, 'window=roles');
    const rolesReopen = await openRolesWindow(browser, main);
    await rolesReopen.locator('.role-list-page').waitFor({ state: 'visible', timeout: 5_000 });

    // 断言成员列表里出现新成员。WorkerCard 有 `${name} 员工卡片` 的 aria-label。
    const newCard = rolesReopen.locator(`[aria-label="${createdMemberName} 员工卡片"]`);
    await expect(newCard).toBeVisible({ timeout: 8_000 });

    await screenshot(rolesReopen, 'p2-tc1-member-created');
  });

  test('TC-2 编辑模板：settings → 模板 tab → 编辑（合规模板）→ 改描述 → 保存', async () => {
    const settings = await openSettingsWindow(browser, main);
    await settings.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });

    // 切到"模板管理" Tab。
    await settings.getByRole('button', { name: /^模板管理$/ }).click();

    // 注意：现有种子数据里大多模板 role 字段 > 32 字符（TemplateEditor ROLE_MAX=32），
    // 点"编辑"后 roleError 非空导致保存锁死，这是已知设计-数据不一致（已上报）。
    // 为保证 TC-2 覆盖"编辑 → 改描述 → 保存"流程可靠，先通过 UI 创建一个 role 合规模板再编辑。
    const seedName = `p2-edit-${Date.now()}`;
    await settings.getByRole('button', { name: /新建模板/ }).click();
    const createModal = settings.locator('.modal').first();
    await expect(createModal).toBeVisible({ timeout: 3_000 });
    await createModal.locator('input[placeholder="frontend-engineer"]').first().fill(seedName);
    await createModal.locator('input[placeholder="engineer"]').first().fill('tester');
    await createModal.getByRole('button', { name: /^保存$/ }).first().click();
    await expect(createModal).toBeHidden({ timeout: 5_000 });

    // 定位该模板的卡片 → 点卡片里的"编辑"按钮。
    // tpl-list__card 卡片里 .tpl-list__name 写 name，ops 栏里有"编辑"按钮。
    const seedCard = settings.locator('.tpl-list__card').filter({ hasText: seedName }).first();
    await expect(seedCard).toBeVisible({ timeout: 5_000 });
    await seedCard.getByRole('button', { name: /^编辑$/ }).click();

    // 编辑 Modal 弹出 — TemplateEditor isEdit=true 时 name 字段 disabled。
    const editModal = settings.locator('.modal').first();
    await expect(editModal).toBeVisible({ timeout: 3_000 });
    await expect(editModal.locator('.tpl-editor')).toBeVisible();

    // 描述字段：placeholder '用一句话描述角色职责'（i18n: template.description_placeholder）。
    const descInput = editModal.locator('input[placeholder="用一句话描述角色职责"]').first();
    await expect(descInput).toBeVisible();
    const newDesc = `E2E 修改 ${Date.now()}`;
    await descInput.fill(newDesc);

    await screenshot(settings, 'p2-tc2-template-edit-filled');

    const saveBtn = editModal.getByRole('button', { name: /^保存$/ }).first();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // 断言 Modal 关闭 = 保存成功。
    await expect(editModal).toBeHidden({ timeout: 5_000 });

    await screenshot(settings, 'p2-tc2-template-saved');
  });

  // TC-3（team-lead 裁决：roles 窗口当前无成员删除入口，改走设置页模板管理的删除流程）
  // settings → 模板管理 tab 的 TemplateList 每张卡带删除按钮 + ConfirmDialog。
  test('TC-3 删除刚创建的成员：settings → 模板管理 → 删除 → 确认 → 列表消失', async () => {
    const settings = await openSettingsWindow(browser, main);
    await settings.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await settings.getByRole('button', { name: /^模板管理$/ }).click();

    // 定位 TC-1 创建的那张模板卡。
    const targetCard = settings
      .locator('.tpl-list__card')
      .filter({ hasText: createdMemberName })
      .first();
    await expect(targetCard).toBeVisible({ timeout: 5_000 });

    // 点卡片里的"删除"按钮 → ConfirmDialog 打开。
    await targetCard.getByRole('button', { name: /^删除$/ }).click();

    // ConfirmDialog = Modal + .confirm-dialog，message 里包含模板名。
    const confirmDialog = settings.locator('.confirm-dialog').first();
    await expect(confirmDialog).toBeVisible({ timeout: 3_000 });
    await expect(confirmDialog).toContainText(createdMemberName);

    await screenshot(settings, 'p2-tc3-delete-confirm');

    // 对话框里的"删除"按钮是 primary 变体，点它真正执行 deleteTemplate。
    await confirmDialog.getByRole('button', { name: /^删除$/ }).click();

    // ConfirmDialog 关闭。
    await expect(confirmDialog).toBeHidden({ timeout: 5_000 });

    // 注意：settings 窗口是独立 React root，templateStore 不跨窗口同步，
    // WS template.deleted 事件只在主窗口 store 生效；当前 SettingsPage 删除后
    // 没有本地 removeTemplate / refetch — 这是第二个交互 bug（已上报）。
    // 用"关窗再开"纯 UI 路径验证"后端确实删了且列表不会再拉回来"。
    await closePanelIfOpen(browser, 'window=settings');
    const settingsReopen = await openSettingsWindow(browser, main);
    await settingsReopen.locator('.panel-window').first().waitFor({ state: 'visible', timeout: 5_000 });
    await settingsReopen.getByRole('button', { name: /^模板管理$/ }).click();

    const reopenedCard = settingsReopen
      .locator('.tpl-list__card')
      .filter({ hasText: createdMemberName });
    await expect(reopenedCard).toHaveCount(0, { timeout: 5_000 });

    await screenshot(settingsReopen, 'p2-tc3-deleted');
  });
});
