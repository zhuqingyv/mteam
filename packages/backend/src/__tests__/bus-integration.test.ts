// 集成测试：handler → bus → subscriber → 副作用（roster 写入）。
// 真实 bus + 真实 subscriber + 真实 in-memory SQLite，不 mock。
// 例外：commRouter 走空壳（测试不起 comm 服务器，也不起真 CLI 进程）；
//       member-driver 若在本进程注册会被其 try-catch 吞掉 spawn 失败，不影响 roster 断言。
// 注意：bus 是模块级单例，destroy() 会让 Subject 永久 complete，
//       所以 boot/teardown 放 beforeAll/afterAll，DB 重置放 beforeEach。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { bootSubscribers, teardownSubscribers } from '../bus/index.js';
import {
  handleCreateInstance,
  handleActivate,
  handleRequestOffline,
  handleDeleteInstance,
} from '../api/panel/role-instances.js';
import { handleRegisterSession } from '../api/panel/sessions.js';
import { RoleTemplate } from '../domain/role-template.js';
import { roster } from '../roster/roster.js';
import { closeDb, getDb } from '../db/connection.js';
import type { CommRouter } from '../comm/router.js';

// 空壳 router：comm-notify.subscriber 只调 dispatch，拿到 msg 就吞掉。
const fakeRouter = {
  dispatch: (): { status: 'ok'; delivered: 0 } => ({ status: 'ok', delivered: 0 }),
} as unknown as CommRouter;

function resetDb(): void {
  closeDb();
  getDb();
}

function seedTemplate(): void {
  RoleTemplate.create({ name: 'tpl', role: 'worker', persona: 'p', availableMcps: [] });
}

describe('bus 集成：handler → subscriber → roster 副作用', () => {
  beforeAll(() => {
    bootSubscribers({ commRouter: fakeRouter });
  });
  afterAll(() => {
    teardownSubscribers();
    closeDb();
  });
  beforeEach(() => {
    resetDb();
    seedTemplate();
  });

  it('handleCreateInstance → roster 有 PENDING entry', () => {
    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'alice' });
    expect(resp.status).toBe(201);
    const instanceId = (resp.body as { id: string }).id;

    const entry = roster.get(instanceId);
    expect(entry).not.toBeNull();
    expect(entry!.memberName).toBe('alice');
    expect(entry!.status).toBe('PENDING');
  });

  it('handleActivate → roster status 变 ACTIVE', () => {
    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'bob' });
    const instanceId = (resp.body as { id: string }).id;

    const actResp = handleActivate(instanceId);
    expect(actResp.status).toBe(200);

    expect(roster.get(instanceId)!.status).toBe('ACTIVE');
  });

  it('handleRequestOffline → roster status 变 PENDING_OFFLINE', () => {
    const leaderResp = handleCreateInstance({
      templateName: 'tpl',
      memberName: 'leader',
      isLeader: true,
    });
    const leaderId = (leaderResp.body as { id: string }).id;
    handleActivate(leaderId);

    const memberResp = handleCreateInstance({ templateName: 'tpl', memberName: 'carol' });
    const memberId = (memberResp.body as { id: string }).id;
    handleActivate(memberId);

    const offResp = handleRequestOffline(memberId, {}, leaderId);
    expect(offResp.status).toBe(200);

    expect(roster.get(memberId)!.status).toBe('PENDING_OFFLINE');
  });

  it('handleDeleteInstance → roster 清空', () => {
    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'dan' });
    const instanceId = (resp.body as { id: string }).id;
    expect(roster.get(instanceId)).not.toBeNull();

    const delResp = handleDeleteInstance(instanceId, false);
    expect(delResp.status).toBe(204);

    expect(roster.get(instanceId)).toBeNull();
  });

  it('handleRegisterSession 对 PENDING 实例 → roster status 变 ACTIVE（旧 bug 回归）', () => {
    const resp = handleCreateInstance({ templateName: 'tpl', memberName: 'eve' });
    const instanceId = (resp.body as { id: string }).id;
    expect(roster.get(instanceId)!.status).toBe('PENDING');

    const regResp = handleRegisterSession({ instanceId, claudeSessionId: 'claude-sess-1' });
    expect(regResp.status).toBe(200);

    expect(roster.get(instanceId)!.status).toBe('ACTIVE');
  });
});
