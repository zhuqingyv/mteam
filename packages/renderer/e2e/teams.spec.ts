// Teams 面板：创建 / 添加成员 / 移除成员 / 解散 的 e2e 场景。
//
// 前置：通过后端 API 造一个 leader 实例 + 一个 worker 实例（不走 UI，
// 因为 instance 面板已有独立测试，不在此重复）。UI 这边只验证 team 操作。
// 注意 isLeader=true 会触发 pty.spawned 启动 claude 子进程，force=1 删除时
// 依赖 ptyManager.kill 正常工作；和 instances.spec 同一个路径。
import { test, expect, type Page } from '@playwright/test';
import {
  uniq,
  deleteTemplateByApi,
  deleteInstanceByApi,
  gotoTab,
} from './helpers';

async function createTemplate(page: Page, name: string): Promise<void> {
  const r = await page.request.post('http://localhost:58580/api/role-templates', {
    data: {
      name,
      role: 'tester',
      description: null,
      persona: null,
      availableMcps: [],
    },
  });
  if (!r.ok()) throw new Error(`seed template failed: ${r.status()} ${await r.text()}`);
}

async function createInstance(
  page: Page,
  templateName: string,
  memberName: string,
  isLeader: boolean,
): Promise<string> {
  const r = await page.request.post('http://localhost:58580/api/role-instances', {
    data: {
      templateName,
      memberName,
      isLeader,
      task: null,
      leaderName: isLeader ? null : null,
    },
  });
  if (!r.ok()) throw new Error(`seed instance failed: ${r.status()} ${await r.text()}`);
  const body = (await r.json()) as { id: string };
  return body.id;
}

test.describe('Teams 面板生命周期', () => {
  let templateName: string;
  let leaderMember: string;
  let workerMember: string;
  let leaderId: string;
  let workerId: string;
  let teamId: string | null = null;

  test.beforeEach(async ({ page }) => {
    templateName = uniq('tpl');
    leaderMember = uniq('ldr');
    workerMember = uniq('wkr');
    await createTemplate(page, templateName);
    leaderId = await createInstance(page, templateName, leaderMember, true);
    workerId = await createInstance(page, templateName, workerMember, false);
    teamId = null;

    await page.goto('/');
    await gotoTab(page, 'team');
  });

  test.afterEach(async ({ page }) => {
    // 顺序：先删 team（team.disbanded 触发成员清理），再删 instance，最后删 template。
    if (teamId) {
      await page.request.post(
        `http://localhost:58580/api/teams/${encodeURIComponent(teamId)}/disband`,
      );
    }
    await deleteInstanceByApi(page, workerId, true);
    await deleteInstanceByApi(page, leaderId, true);
    await deleteTemplateByApi(page, templateName);
  });

  // 创建 team 的 UI 步骤：填名字、下拉选 leader、提交。
  async function createTeamViaUi(page: Page, name: string): Promise<string> {
    await page.getByTestId('team-refresh').click();
    await page.getByTestId('team-create-name').fill(name);
    await page.getByTestId('team-create-leader').selectOption(leaderId);
    await page.getByTestId('team-create-submit').click();

    // 从列表里找到该行 —— 通过 name 文本匹配反推 testid 里的 teamId。
    const row = page.locator('tr', { hasText: name }).first();
    await row.waitFor({ state: 'visible' });
    const testId = await row.getAttribute('data-testid');
    if (!testId || !testId.startsWith('team-row-')) {
      throw new Error(`unexpected team row testid: ${testId}`);
    }
    return testId.slice('team-row-'.length);
  }

  test('创建 team → 列表出现', async ({ page }) => {
    const name = uniq('tm');
    teamId = await createTeamViaUi(page, name);

    await expect(page.getByTestId(`team-row-${teamId}`)).toBeVisible();
    await expect(page.getByTestId(`team-name-${teamId}`)).toHaveText(name);
    await expect(page.getByTestId(`team-status-${teamId}`)).toHaveText('ACTIVE');
  });

  test('添加成员 → 成员列表出现该 instance', async ({ page }) => {
    const name = uniq('tm');
    teamId = await createTeamViaUi(page, name);

    await page.getByTestId(`team-expand-${teamId}`).click();
    await page.getByTestId(`team-add-member-select-${teamId}`).selectOption(workerId);
    await page.getByTestId(`team-add-member-role-${teamId}`).fill('coder');
    await page.getByTestId(`team-add-member-submit-${teamId}`).click();

    const memberRow = page.getByTestId(`team-member-row-${teamId}-${workerId}`);
    await expect(memberRow).toBeVisible();
    await expect(memberRow).toContainText('coder');
    await expect(page.getByTestId(`team-member-count-${teamId}`)).toHaveText('1');
  });

  test('移除成员 → 成员消失', async ({ page }) => {
    const name = uniq('tm');
    teamId = await createTeamViaUi(page, name);

    await page.getByTestId(`team-expand-${teamId}`).click();
    await page.getByTestId(`team-add-member-select-${teamId}`).selectOption(workerId);
    await page.getByTestId(`team-add-member-submit-${teamId}`).click();

    const memberRow = page.getByTestId(`team-member-row-${teamId}-${workerId}`);
    await expect(memberRow).toBeVisible();

    await page.getByTestId(`team-remove-member-${teamId}-${workerId}`).click();
    await expect(memberRow).toHaveCount(0);
  });

  test('解散 team → 状态变 DISBANDED 且操作按钮消失', async ({ page }) => {
    const name = uniq('tm');
    teamId = await createTeamViaUi(page, name);

    await expect(page.getByTestId(`team-status-${teamId}`)).toHaveText('ACTIVE');

    await page.getByTestId(`team-disband-${teamId}`).click();
    await expect(page.getByTestId(`team-status-${teamId}`)).toHaveText('DISBANDED');
    // ACTIVE 专属按钮应同时消失
    await expect(page.getByTestId(`team-disband-${teamId}`)).toHaveCount(0);
    await expect(page.getByTestId(`team-expand-${teamId}`)).toHaveCount(0);
  });
});
