// 角色模板面板：创建 / 编辑 / 删除 的 e2e 场景。
import { test, expect } from '@playwright/test';
import { uniq, deleteTemplateByApi, gotoTab } from './helpers';

test.describe('模板面板 CRUD', () => {
  let name: string;

  test.beforeEach(async ({ page }) => {
    name = uniq('tpl');
    await page.goto('/');
    await gotoTab(page, 'template');
  });

  test.afterEach(async ({ page }) => {
    // 兜底清理，避免遗留脏数据
    await deleteTemplateByApi(page, name);
  });

  test('创建模板后列表出现', async ({ page }) => {
    // 打开模板 tab 并填入最少字段
    await page.getByTestId('template-create-name').fill(name);
    await page.getByTestId('template-create-role').fill('tester');
    await page.getByTestId('template-create-submit').click();

    // 行应出现在列表
    const row = page.getByTestId(`template-row-${name}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('tester');
  });

  test('编辑模板 → role 字段更新', async ({ page }) => {
    // 先创建
    await page.getByTestId('template-create-name').fill(name);
    await page.getByTestId('template-create-role').fill('initial');
    await page.getByTestId('template-create-submit').click();
    await expect(page.getByTestId(`template-row-${name}`)).toBeVisible();

    // 点编辑并更新 role
    await page.getByTestId(`template-edit-${name}`).click();
    // 编辑表单出现后填写新 role
    const editRole = page.getByTestId('template-edit-role');
    await expect(editRole).toBeVisible();
    await editRole.fill('updated');
    await page.getByTestId('template-edit-submit').click();

    // 列表里 role 变为 updated
    const row = page.getByTestId(`template-row-${name}`);
    await expect(row).toContainText('updated');
  });

  test('删除模板 → 列表消失', async ({ page }) => {
    // 创建
    await page.getByTestId('template-create-name').fill(name);
    await page.getByTestId('template-create-role').fill('tester');
    await page.getByTestId('template-create-submit').click();
    await expect(page.getByTestId(`template-row-${name}`)).toBeVisible();

    // 删除
    await page.getByTestId(`template-delete-${name}`).click();
    await expect(page.getByTestId(`template-row-${name}`)).toHaveCount(0);
  });
});
