// W2-5 proxy-router 单测。完成判据 §2：真 store + 真 DB，覆盖
//   · 3 种 mode × 各 2 个样例
//   · custom 通配（team.* / container.* / 不命中 drop）
//   · proxy_all 的 fallback 路径（primary 不在线 → direct）
//   · drop 路径（custom 全不命中 / 规则显式 drop）
// 不 mock；bus/types 导入的 BusEvent 对象按最小合法字面量构造。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createNotificationStore } from './notification-store.js';
import { createProxyRouter, type ProxyRouter } from './proxy-router.js';
import type { CustomRule, NotificationStore } from './types.js';
import { closeDb, getDb } from '../db/connection.js';
import type {
  BusEvent,
  ContainerCrashedEvent,
  DriverErrorEvent,
  TeamCreatedEvent,
  TeamMemberJoinedEvent,
} from '../bus/types.js';

const TS = '2026-04-25T10:00:00.000Z';
const SRC = 'test';

const teamCreated = (teamId = 't1'): TeamCreatedEvent => ({
  type: 'team.created', ts: TS, source: SRC,
  teamId, name: teamId, leaderInstanceId: 'inst_leader',
});

const teamMemberJoined = (teamId = 't1'): TeamMemberJoinedEvent => ({
  type: 'team.member_joined', ts: TS, source: SRC,
  teamId, instanceId: 'inst_x', roleInTeam: null,
});

const containerCrashed = (): ContainerCrashedEvent => ({
  type: 'container.crashed', ts: TS, source: SRC,
  agentId: 'inst_1', cliType: 'claude', exitCode: 1, signal: null,
});

const driverError = (): DriverErrorEvent => ({
  type: 'driver.error', ts: TS, source: SRC,
  driverId: 'inst_1', message: 'boom',
});

let store: NotificationStore;
let warnLog: string[];

beforeEach(() => {
  closeDb();
  const db = getDb();
  store = createNotificationStore(db);
  warnLog = [];
});

afterAll(() => {
  closeDb();
});

function makeRouter(primaryId: string | null): ProxyRouter {
  return createProxyRouter({
    store,
    getPrimaryAgentInstanceId: () => primaryId,
    warn: (m) => warnLog.push(m),
  });
}

describe('proxy-router · proxy_all', () => {
  beforeEach(() => {
    store.upsert({ id: 'default', userId: null, mode: 'proxy_all', updatedAt: TS });
    store.upsert({ id: 'u1', userId: 'u1', mode: 'proxy_all', updatedAt: TS });
  });

  it('primary 在线 → primary_agent', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(containerCrashed(), null)).toEqual({ kind: 'primary_agent' });
    expect(r.route(teamCreated(), null)).toEqual({ kind: 'primary_agent' });
    expect(warnLog).toHaveLength(0);
  });

  it('primary 不在线 → fallback direct + warn', () => {
    const r = makeRouter(null);
    expect(r.route(containerCrashed(), null)).toEqual({ kind: 'user', userId: 'local' });
    expect(r.route(driverError(), 'u1')).toEqual({ kind: 'user', userId: 'u1' });
    expect(warnLog).toHaveLength(2);
    expect(warnLog[0]).toContain('proxy_all fallback direct');
    expect(warnLog[0]).toContain('container.crashed');
  });
});

describe('proxy-router · direct', () => {
  beforeEach(() => {
    store.upsert({ id: 'default', userId: null, mode: 'direct', updatedAt: TS });
    store.upsert({ id: 'u1', userId: 'u1', mode: 'direct', updatedAt: TS });
  });

  it('userId=null → user:local', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(teamCreated(), null)).toEqual({ kind: 'user', userId: 'local' });
  });

  it('userId=u1 → user:u1', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(teamMemberJoined(), 'u1')).toEqual({ kind: 'user', userId: 'u1' });
  });
});

describe('proxy-router · custom', () => {
  const rules: CustomRule[] = [
    { matchType: 'team.*', to: { kind: 'user', userId: 'u1' } },
    { matchType: 'container.crashed', to: { kind: 'primary_agent' } },
    { matchType: 'driver.error', to: { kind: 'drop' } },
  ];

  beforeEach(() => {
    store.upsert({ id: 'default', userId: null, mode: 'custom', rules, updatedAt: TS });
  });

  it('通配 team.* 命中 team.created / team.member_joined', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(teamCreated(), null)).toEqual({ kind: 'user', userId: 'u1' });
    expect(r.route(teamMemberJoined(), null)).toEqual({ kind: 'user', userId: 'u1' });
  });

  it('完全相等 container.crashed → primary_agent', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(containerCrashed(), null)).toEqual({ kind: 'primary_agent' });
  });

  it('显式 drop 规则命中 → drop', () => {
    const r = makeRouter('inst_leader');
    expect(r.route(driverError(), null)).toEqual({ kind: 'drop' });
  });

  it('全不命中 → drop', () => {
    store.upsert({
      id: 'default', userId: null, mode: 'custom',
      rules: [{ matchType: 'container.*', to: { kind: 'drop' } }],
      updatedAt: TS,
    });
    const r = makeRouter('inst_leader');
    expect(r.route(teamCreated(), null)).toEqual({ kind: 'drop' });
  });

  it('首命中即返回，后续规则不评估（顺序敏感）', () => {
    // 两条都命中 team.created；第一条是 user:u1，第二条是 drop。
    // router 应返回第一条。
    store.upsert({
      id: 'default', userId: null, mode: 'custom',
      rules: [
        { matchType: 'team.*', to: { kind: 'user', userId: 'u1' } },
        { matchType: 'team.created', to: { kind: 'drop' } },
      ],
      updatedAt: TS,
    });
    const r = makeRouter('inst_leader');
    expect(r.route(teamCreated(), null)).toEqual({ kind: 'user', userId: 'u1' });
  });

  it('规则 to 为 agent 时返回 agent + instanceId', () => {
    store.upsert({
      id: 'default', userId: null, mode: 'custom',
      rules: [{ matchType: 'container.crashed', to: { kind: 'agent', instanceId: 'inst_watcher' } }],
      updatedAt: TS,
    });
    const r = makeRouter('inst_leader');
    expect(r.route(containerCrashed(), null)).toEqual({
      kind: 'agent', instanceId: 'inst_watcher',
    });
  });
});

describe('proxy-router · 按 userId 查不同配置', () => {
  it('u1 proxy_all + u2 direct 各走各的', () => {
    store.upsert({ id: 'u1', userId: 'u1', mode: 'proxy_all', updatedAt: TS });
    store.upsert({ id: 'u2', userId: 'u2', mode: 'direct', updatedAt: TS });
    const r = makeRouter('inst_leader');

    expect(r.route(teamCreated(), 'u1')).toEqual({ kind: 'primary_agent' });
    expect(r.route(teamCreated(), 'u2')).toEqual({ kind: 'user', userId: 'u2' });
  });
});

describe('proxy-router · 非业务 import 守门', () => {
  it('源文件不 import bus 运行时 / comm / ws / db', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const src = await fs.readFile(
      path.resolve(path.dirname(here), 'proxy-router.ts'),
      'utf8',
    );
    // BusEvent 是 type-only import 允许；任何运行时 from ".../bus/" / ".../comm/" / ".../ws/" / ".../db/" 都禁
    const runtimeImport = /^import\s+(?!type\b)[^;]*from ['"][^'"]*\/(bus|comm|ws|db)\//m;
    expect(runtimeImport.test(src)).toBe(false);
  });
});

// 仅编译期使用，避免 BusEvent 未使用告警
const _compileTouch: BusEvent = teamCreated();
void _compileTouch;
