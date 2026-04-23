// 花名册面板：添加(走 role_instance 自动登记) / 搜索 / 改备注(alias) / 删除 的 e2e 场景。
//
// 架构说明：roster 不是独立表，它是 role_instances 的视图。
// 面板上"添加 roster 条目"表单要求 instanceId 必须已在 role_instances 存在，
// 否则后端返回 400: "instance 'X' not in role_instances; create it first"。
// 因此 e2e 用后端 API 先把 role_instance 建出来，再用 UI 添加 roster 条目（等价于 UPDATE alias）。
import { test, expect } from '@playwright/test';
import {
  uniq,
  deleteRosterByApi,
  deleteTemplateByApi,
  deleteInstanceByApi,
  gotoTab,
} from './helpers';

// 前置：创建模板 + role_instance，返回可用于 roster 的 instanceId。
async function seedInstance(
  page: import('@playwright/test').Page,
  templateName: string,
  memberName: string,
): Promise<string> {
  // 建模板
  const tplResp = await page.request.post(
    'http://localhost:58580/api/role-templates',
    {
      data: {
        name: templateName,
        role: 'tester',
        description: null,
        persona: null,
        availableMcps: [],
      },
    },
  );
  if (!tplResp.ok()) {
    throw new Error(`seed template failed: ${tplResp.status()} ${await tplResp.text()}`);
  }
  // 建 role_instance
  const instResp = await page.request.post(
    'http://localhost:58580/api/role-instances',
    {
      data: {
        templateName,
        memberName,
        isLeader: false,
        task: null,
        leaderName: null,
      },
    },
  );
  if (!instResp.ok()) {
    throw new Error(`seed instance failed: ${instResp.status()} ${await instResp.text()}`);
  }
  const body = (await instResp.json()) as { id: string };
  return body.id;
}

test.describe('花名册面板 CRUD', () => {
  let templateName: string;
  let memberName: string;
  let instanceId: string;

  test.beforeEach(async ({ page }) => {
    templateName = uniq('tpl');
    memberName = uniq('m');
    instanceId = await seedInstance(page, templateName, memberName);
    await page.goto('/');
    await gotoTab(page, 'roster');
  });

  test.afterEach(async ({ page }) => {
    // 依赖顺序：roster 依赖 role_instance 依赖 template，反向清理。
    await deleteRosterByApi(page, instanceId);
    await deleteInstanceByApi(page, instanceId, true);
    await deleteTemplateByApi(page, templateName);
  });

  // UI 添加表单：等价于给已存在的 role_instance 设 alias。
  async function createEntry(
    page: import('@playwright/test').Page,
    extra?: { alias?: string },
  ): Promise<void> {
    await page.getByTestId('roster-create-instance-id').fill(instanceId);
    await page.getByTestId('roster-create-member').fill(memberName);
    if (extra?.alias) await page.getByTestId('roster-create-alias').fill(extra.alias);
    await page.getByTestId('roster-create-address').fill('127.0.0.1:0');
    await page.getByTestId('roster-create-submit').click();
  }

  test('添加成员后列表出现', async ({ page }) => {
    // seedInstance 已经把 role_instance 建出来，刷新一下就能看到
    await page.getByTestId('roster-refresh').click();
    const row = page.getByTestId(`roster-row-${instanceId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(memberName);
  });

  test('搜索能命中新建成员', async ({ page }) => {
    await page.getByTestId('roster-refresh').click();
    await page.getByTestId('roster-search-input').fill(memberName);
    await page.getByTestId('roster-search-submit').click();

    const responseBox = page.getByTestId('roster-response');
    await expect(responseBox).toContainText(memberName);
  });

  test('改 alias → 列表 alias 更新', async ({ page }) => {
    await page.getByTestId('roster-refresh').click();
    const row = page.getByTestId(`roster-row-${instanceId}`);
    await expect(row).toBeVisible();

    const newAlias = uniq('alias');
    await page.getByTestId(`roster-alias-input-${instanceId}`).fill(newAlias);
    await page.getByTestId(`roster-set-alias-${instanceId}`).click();

    await expect(row).toContainText(newAlias);
  });

  test('删除成员 → 列表消失', async ({ page }) => {
    await page.getByTestId('roster-refresh').click();
    await expect(page.getByTestId(`roster-row-${instanceId}`)).toBeVisible();

    await page.getByTestId(`roster-delete-${instanceId}`).click();
    await expect(page.getByTestId(`roster-row-${instanceId}`)).toHaveCount(0);
  });
});
