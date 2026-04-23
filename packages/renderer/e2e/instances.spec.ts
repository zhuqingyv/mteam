// 角色实例面板：创建 / activate / request-offline / 删除 的 e2e 场景。
import { test, expect } from '@playwright/test';
import {
  uniq,
  deleteTemplateByApi,
  deleteInstanceByApi,
  gotoTab,
} from './helpers';

test.describe('实例面板生命周期', () => {
  let templateName: string;
  let memberName: string;
  const trackedInstanceIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    templateName = uniq('tpl');
    memberName = uniq('m');
    // 先用后端 API 建好模板（UI 测过了，这里直接走 API 更快）
    await page.request.post('http://localhost:58580/api/role-templates', {
      data: {
        name: templateName,
        role: 'tester',
        description: null,
        persona: null,
        availableMcps: [],
      },
    });

    await page.goto('/');
    await gotoTab(page, 'instance');
    trackedInstanceIds.length = 0;
  });

  test.afterEach(async ({ page }) => {
    for (const id of trackedInstanceIds) {
      await deleteInstanceByApi(page, id, true);
    }
    await deleteTemplateByApi(page, templateName);
  });

  // 从列表里抓到当前 member 对应的 instanceId（通过 row 的 data-testid 反推）。
  async function findInstanceIdByMember(page: import('@playwright/test').Page, member: string): Promise<string> {
    // 行 data-testid 是 instance-row-<id>，用 member 文本定位该行再抽 id
    const row = page.locator('tr', { hasText: member }).first();
    await row.waitFor({ state: 'visible' });
    const testId = await row.getAttribute('data-testid');
    if (!testId || !testId.startsWith('instance-row-')) {
      throw new Error(`unexpected row testid: ${testId}`);
    }
    return testId.slice('instance-row-'.length);
  }

  test('创建实例 → 默认 PENDING 状态', async ({ page }) => {
    await page.getByTestId('instance-create-template').fill(templateName);
    await page.getByTestId('instance-create-member').fill(memberName);
    await page.getByTestId('instance-create-submit').click();

    const id = await findInstanceIdByMember(page, memberName);
    trackedInstanceIds.push(id);
    await expect(page.getByTestId(`instance-status-${id}`)).toHaveText('PENDING');
  });

  test('activate → 状态变 ACTIVE', async ({ page }) => {
    await page.getByTestId('instance-create-template').fill(templateName);
    await page.getByTestId('instance-create-member').fill(memberName);
    await page.getByTestId('instance-create-submit').click();

    const id = await findInstanceIdByMember(page, memberName);
    trackedInstanceIds.push(id);
    await expect(page.getByTestId(`instance-status-${id}`)).toHaveText('PENDING');

    await page.getByTestId(`instance-activate-${id}`).click();
    await expect(page.getByTestId(`instance-status-${id}`)).toHaveText('ACTIVE');
  });

  test('request-offline → 状态变 PENDING_OFFLINE', async ({ page }) => {
    // leader 实例：需要 isLeader=true 以便它自己发起下线请求
    const leaderMember = uniq('ldr');
    await page.getByTestId('instance-create-template').fill(templateName);
    await page.getByTestId('instance-create-member').fill(leaderMember);
    await page.getByTestId('instance-create-isleader').check();
    await page.getByTestId('instance-create-submit').click();

    const leaderId = await findInstanceIdByMember(page, leaderMember);
    trackedInstanceIds.push(leaderId);

    // 激活成 ACTIVE 才能发起下线
    await page.getByTestId(`instance-activate-${leaderId}`).click();
    await expect(page.getByTestId(`instance-status-${leaderId}`)).toHaveText('ACTIVE');

    // 清空表单并创建成员实例（leaderName 指向刚才的 leader）
    await page.getByTestId('instance-create-isleader').uncheck();
    await page.getByTestId('instance-create-template').fill(templateName);
    await page.getByTestId('instance-create-member').fill(memberName);
    await page.getByTestId('instance-create-leader').fill(leaderMember);
    await page.getByTestId('instance-create-submit').click();

    const workerId = await findInstanceIdByMember(page, memberName);
    trackedInstanceIds.push(workerId);

    // worker 必须 ACTIVE 才能被请求下线
    await page.getByTestId(`instance-activate-${workerId}`).click();
    await expect(page.getByTestId(`instance-status-${workerId}`)).toHaveText('ACTIVE');

    // 设 callerInstanceId 为 leader 的 id
    await page.getByTestId('instance-caller-id').fill(leaderId);
    await page.getByTestId(`instance-request-offline-${workerId}`).click();

    await expect(page.getByTestId(`instance-status-${workerId}`)).toHaveText('PENDING_OFFLINE');
  });

  test('删除实例 → 列表消失', async ({ page }) => {
    await page.getByTestId('instance-create-template').fill(templateName);
    await page.getByTestId('instance-create-member').fill(memberName);
    await page.getByTestId('instance-create-submit').click();

    const id = await findInstanceIdByMember(page, memberName);
    // 强删（PENDING 可直接 DELETE，但 force 更稳）
    await page.getByTestId(`instance-force-delete-${id}`).click();

    await expect(page.getByTestId(`instance-row-${id}`)).toHaveCount(0);
  });
});
