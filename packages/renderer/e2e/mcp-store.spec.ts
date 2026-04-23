// MCP Store 面板：列表展示 builtin / 安装 / 卸载 / 卸载 builtin 被拒。
import { test, expect } from '@playwright/test';
import { uniq, uninstallMcpByApi, gotoTab } from './helpers';

test.describe('MCP Store 面板', () => {
  let mcpName: string;

  test.beforeEach(async ({ page }) => {
    mcpName = uniq('mcp');
    await page.goto('/');
    await gotoTab(page, 'mcp-store');
  });

  test.afterEach(async ({ page }) => {
    await uninstallMcpByApi(page, mcpName);
  });

  test('列表展示 mteam 内置条目', async ({ page }) => {
    const row = page.getByTestId('mcp-row-mteam');
    await expect(row).toBeVisible();
    await expect(row).toContainText('yes'); // builtin=yes
    // 内置卸载按钮应禁用
    await expect(page.getByTestId('mcp-uninstall-mteam')).toBeDisabled();
  });

  test('安装新 MCP → 列表增加条目', async ({ page }) => {
    await page.getByTestId('mcp-create-name').fill(mcpName);
    await page.getByTestId('mcp-create-display').fill(mcpName);
    await page.getByTestId('mcp-create-description').fill('e2e installed');
    await page.getByTestId('mcp-create-command').fill('echo');
    await page.getByTestId('mcp-create-args').fill('hello');
    await page.getByTestId('mcp-create-submit').click();

    const row = page.getByTestId(`mcp-row-${mcpName}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('echo');
  });

  test('卸载自己安装的 MCP → 列表消失', async ({ page }) => {
    // 先安装
    await page.getByTestId('mcp-create-name').fill(mcpName);
    await page.getByTestId('mcp-create-command').fill('echo');
    await page.getByTestId('mcp-create-submit').click();
    await expect(page.getByTestId(`mcp-row-${mcpName}`)).toBeVisible();

    // 卸载
    await page.getByTestId(`mcp-uninstall-${mcpName}`).click();
    await expect(page.getByTestId(`mcp-row-${mcpName}`)).toHaveCount(0);
  });

  test('卸载内置 mteam → 后端返回 403', async ({ page }) => {
    // UI 按钮被 disabled，直接用 API 验证 403 契约，避免绕过 UI 保护
    const resp = await page.request.delete('http://localhost:58580/api/mcp-store/mteam');
    expect(resp.status()).toBe(403);
  });
});
