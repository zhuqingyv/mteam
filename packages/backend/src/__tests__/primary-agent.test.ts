// PrimaryAgent 单测：configure / getConfig / isRunning / start 错误路径 / stop 幂等。
// 不测真实 spawn（避免外部依赖）：start 无配置 → 抛错即可覆盖校验逻辑。
// 用 :memory: SQLite + 隔离 EventBus，保证用例间干净。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { PrimaryAgent } from '../primary-agent/primary-agent.js';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';
import { closeDb, getDb } from '../db/connection.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resetDb(): void {
  closeDb();
  getDb();
}

function collectEvents(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));
  return events;
}

describe('PrimaryAgent.configure', () => {
  beforeEach(() => {
    resetDb();
  });
  afterAll(() => {
    closeDb();
  });

  it('首次 configure：写入一行，id 是 UUID，status=STOPPED', () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const agent = new PrimaryAgent(bus);

    const row = agent.configure({ name: 'Alice', cliType: 'claude' });
    expect(row.id).toMatch(UUID_RE);
    expect(row.name).toBe('Alice');
    expect(row.cliType).toBe('claude');
    expect(row.status).toBe('STOPPED');
    expect(row.systemPrompt).toBe('');
    expect(row.mcpConfig).toEqual([]);

    const count = (getDb().prepare('SELECT COUNT(*) as c FROM primary_agent').get() as { c: number }).c;
    expect(count).toBe(1);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('primary_agent.configured');
  });

  it('第二次 configure：id 不变，仅字段更新', () => {
    const bus = new EventBus();
    const agent = new PrimaryAgent(bus);
    const first = agent.configure({ name: 'A', cliType: 'claude' });
    const second = agent.configure({ name: 'B', systemPrompt: 'hi' });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('B');
    expect(second.cliType).toBe('claude');
    expect(second.systemPrompt).toBe('hi');

    const count = (getDb().prepare('SELECT COUNT(*) as c FROM primary_agent').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('configure 带 mcpConfig → 持久化', () => {
    const bus = new EventBus();
    const agent = new PrimaryAgent(bus);
    const mcpConfig = [{ serverName: 'mnemo', mode: 'all' as const }];
    const row = agent.configure({ name: 'A', cliType: 'claude', mcpConfig });
    expect(row.mcpConfig).toEqual(mcpConfig);
  });
});

describe('PrimaryAgent.getConfig', () => {
  beforeEach(() => {
    resetDb();
  });

  it('未配置 → null', () => {
    const agent = new PrimaryAgent(new EventBus());
    expect(agent.getConfig()).toBeNull();
  });

  it('已配置 → 返回 row 数据', () => {
    const agent = new PrimaryAgent(new EventBus());
    const created = agent.configure({ name: 'X', cliType: 'claude' });
    const got = agent.getConfig();
    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect(got!.name).toBe('X');
  });
});

describe('PrimaryAgent.isRunning / start / stop', () => {
  beforeEach(() => {
    resetDb();
  });

  it('初始 isRunning === false', () => {
    const agent = new PrimaryAgent(new EventBus());
    expect(agent.isRunning()).toBe(false);
  });

  it('start 未配置 → 抛错', async () => {
    const agent = new PrimaryAgent(new EventBus());
    await expect(agent.start()).rejects.toThrow(/not configured/);
    expect(agent.isRunning()).toBe(false);
  });

  it('stop 未运行 → 不抛错（幂等）', async () => {
    const agent = new PrimaryAgent(new EventBus());
    await expect(agent.stop()).resolves.toBeUndefined();
  });

  it('configure 后 stop → 不抛错，status 保持 STOPPED', async () => {
    const agent = new PrimaryAgent(new EventBus());
    agent.configure({ name: 'A', cliType: 'claude' });
    await expect(agent.stop()).resolves.toBeUndefined();
    expect(agent.getConfig()!.status).toBe('STOPPED');
  });
});
