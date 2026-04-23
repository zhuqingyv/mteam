// 测试辅助：统一处理数据清理和唯一命名，避免 suite 之间互相污染。
import type { Page } from '@playwright/test';

// 生成带时间戳的唯一名字，避免并发 / 多次 run 冲突。
export function uniq(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000)}`;
}

// 通过后端 API 删除模板（测试前置/后置清理用，避免依赖 UI）。
export async function deleteTemplateByApi(page: Page, name: string): Promise<void> {
  await page.request.delete(
    `http://localhost:58580/api/role-templates/${encodeURIComponent(name)}`,
  );
}

// 通过后端 API 删除实例。
export async function deleteInstanceByApi(page: Page, id: string, force = true): Promise<void> {
  const q = force ? '?force=1' : '';
  await page.request.delete(
    `http://localhost:58580/api/role-instances/${encodeURIComponent(id)}${q}`,
  );
}

// 通过后端 API 删除 roster 条目。
export async function deleteRosterByApi(page: Page, id: string): Promise<void> {
  await page.request.delete(
    `http://localhost:58580/api/roster/${encodeURIComponent(id)}`,
  );
}

// 通过后端 API 卸载 MCP。
export async function uninstallMcpByApi(page: Page, name: string): Promise<void> {
  await page.request.delete(
    `http://localhost:58580/api/mcp-store/${encodeURIComponent(name)}`,
  );
}

// 切到指定 tab 的便捷函数。
export async function gotoTab(
  page: Page,
  tab: 'template' | 'instance' | 'roster' | 'mcp-store',
): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click();
}
