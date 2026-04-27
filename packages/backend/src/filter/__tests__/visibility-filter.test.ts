// W2-4 visibility-filter 单测。不 mock：TEAM_HUB_V2_DB=:memory: 起真实 SQLite + 真 FilterStore。
// 覆盖 REGRESSION.md 2.x（R2-1 ~ R2-5）+ 额外 target 抽取 / 运行期 upsert 生效 / 规则变更不缓存。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type {
  ActorPrincipal,
  VisibilityRule,
} from '../types.js';
import type {
  BusEvent,
  CommMessageSentEvent,
  DriverTextEvent,
  TeamMemberJoinedEvent,
  CommRegisteredEvent,
  TemplateCreatedEvent,
  ContainerStartedEvent,
  InstanceActivatedEvent,
} from '../../bus/types.js';
import { createFilterStore } from '../filter-store.js';
import { createVisibilityFilter } from '../visibility-filter.js';
import { closeDb } from '../../db/connection.js';

let store: ReturnType<typeof createFilterStore>;
let filter: ReturnType<typeof createVisibilityFilter>;

const baseTs = '2026-04-25T00:00:00.000Z';

function rule(overrides: Partial<VisibilityRule> = {}): VisibilityRule {
  return {
    id: 'r_1',
    principal: { kind: 'user', userId: 'u1' },
    target: { kind: 'agent', instanceId: 'inst_leak' },
    effect: 'deny',
    createdAt: baseTs,
    ...overrides,
  };
}

function commSent(
  from: string,
  to: string,
  id = 'msg_1',
): CommMessageSentEvent {
  return {
    type: 'comm.message_sent',
    ts: baseTs,
    source: 'test',
    messageId: id,
    from,
    to,
  };
}

function driverText(driverId: string, content = 'hi'): DriverTextEvent {
  return {
    type: 'driver.text',
    ts: baseTs,
    source: 'test',
    driverId,
    content,
  };
}

function teamMemberJoined(
  teamId: string,
  instanceId = 'inst_any',
): TeamMemberJoinedEvent {
  return {
    type: 'team.member_joined',
    ts: baseTs,
    source: 'test',
    teamId,
    instanceId,
    roleInTeam: null,
  };
}

beforeEach(() => {
  closeDb();
  store = createFilterStore();
  filter = createVisibilityFilter(store);
});

afterAll(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// R2-1 无规则 → default_allow
// ---------------------------------------------------------------------------
describe('default_allow 兜底', () => {
  it('无任何规则 + comm 事件 → allow / byRuleId=default_allow', () => {
    const ev = commSent('agent:i1', 'user:u1');
    const u1: ActorPrincipal = { kind: 'user', userId: 'u1' };
    expect(filter.canSee(u1, ev)).toBe(true);
    expect(filter.decide(u1, ev)).toEqual({
      decision: 'allow',
      byRuleId: 'default_allow',
    });
  });

  it('有规则但 principal 不匹配 → default_allow', () => {
    store.upsert(
      rule({
        id: 'r_u2_deny',
        principal: { kind: 'user', userId: 'u2' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'deny',
      }),
    );
    const ev = commSent('agent:i1', 'user:u1');
    expect(filter.decide({ kind: 'user', userId: 'u1' }, ev)).toEqual({
      decision: 'allow',
      byRuleId: 'default_allow',
    });
  });

  it('有规则但 target 抽不出（template.*）→ default_allow', () => {
    store.upsert(rule({ id: 'r_u1_any' }));
    const ev: TemplateCreatedEvent = {
      type: 'template.created',
      ts: baseTs,
      source: 'test',
      templateName: 'whatever',
    };
    expect(
      filter.decide({ kind: 'user', userId: 'u1' }, ev),
    ).toEqual({ decision: 'allow', byRuleId: 'default_allow' });
  });
});

// ---------------------------------------------------------------------------
// R2-2 deny 短路
// ---------------------------------------------------------------------------
describe('deny 规则短路', () => {
  it('comm from agent:i1 到 user:u1，u1 对 i1 有 deny → deny', () => {
    store.upsert(
      rule({
        id: 'r_deny',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'deny',
      }),
    );
    const ev = commSent('agent:i1', 'user:u1');
    const u1: ActorPrincipal = { kind: 'user', userId: 'u1' };
    expect(filter.canSee(u1, ev)).toBe(false);
    expect(filter.decide(u1, ev)).toEqual({
      decision: 'deny',
      byRuleId: 'r_deny',
    });
  });
});

// ---------------------------------------------------------------------------
// R2-3 allow 规则明确放行
// ---------------------------------------------------------------------------
describe('allow 规则命中', () => {
  it('allow rule（user u1 → team t1）+ team.member_joined teamId=t1 → allow 且 byRuleId 非 default_allow', () => {
    store.upsert(
      rule({
        id: 'r_allow_t1',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'team', teamId: 't1' },
        effect: 'allow',
      }),
    );
    const ev = teamMemberJoined('t1');
    const d = filter.decide({ kind: 'user', userId: 'u1' }, ev);
    expect(d.decision).toBe('allow');
    expect(d.byRuleId).toBe('r_allow_t1');
    expect(d.byRuleId).not.toBe('default_allow');
  });
});

// ---------------------------------------------------------------------------
// R2-4 deny 优先
// ---------------------------------------------------------------------------
describe('deny 优先于 allow', () => {
  it('同 principal 对同 target 既 allow 又 deny → deny', () => {
    store.upsert(
      rule({
        id: 'r_allow',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'allow',
      }),
    );
    store.upsert(
      rule({
        id: 'r_deny',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'deny',
      }),
    );
    const ev = driverText('i1');
    const d = filter.decide({ kind: 'user', userId: 'u1' }, ev);
    expect(d).toEqual({ decision: 'deny', byRuleId: 'r_deny' });
  });

  it('deny 命中任一 target 即短路（comm from 命中 deny，to 命中 allow，仍 deny）', () => {
    store.upsert(
      rule({
        id: 'r_allow_to',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'user', userId: 'u1' },
        effect: 'allow',
      }),
    );
    store.upsert(
      rule({
        id: 'r_deny_from',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i_leak' },
        effect: 'deny',
      }),
    );
    const ev = commSent('agent:i_leak', 'user:u1');
    const d = filter.decide({ kind: 'user', userId: 'u1' }, ev);
    expect(d).toEqual({ decision: 'deny', byRuleId: 'r_deny_from' });
  });
});

// ---------------------------------------------------------------------------
// driver.* / instance.* / container.* 的 target 抽取
// ---------------------------------------------------------------------------
describe('target 抽取覆盖', () => {
  it('driver.* 按 driverId → agent.instanceId 匹配', () => {
    store.upsert(
      rule({
        id: 'r_drv',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'deny',
      }),
    );
    const ev = driverText('i1');
    expect(filter.canSee({ kind: 'user', userId: 'u1' }, ev)).toBe(false);
  });

  it('container.* 按 agentId → agent.instanceId 匹配', () => {
    store.upsert(
      rule({
        id: 'r_ctr',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'iC' },
        effect: 'deny',
      }),
    );
    const ev: ContainerStartedEvent = {
      type: 'container.started',
      ts: baseTs,
      source: 'test',
      agentId: 'iC',
      runtimeKind: 'host',
      containerId: '12345',
    };
    expect(filter.canSee({ kind: 'user', userId: 'u1' }, ev)).toBe(false);
  });

  it('instance.activated 按 instanceId 匹配', () => {
    store.upsert(
      rule({
        id: 'r_ins',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'iX' },
        effect: 'deny',
      }),
    );
    const ev: InstanceActivatedEvent = {
      type: 'instance.activated',
      ts: baseTs,
      source: 'test',
      instanceId: 'iX',
      actor: null,
    };
    expect(filter.canSee({ kind: 'user', userId: 'u1' }, ev)).toBe(false);
  });

  it('team.member_joined 同时命中 teamId 或 instanceId（任一即可）', () => {
    store.upsert(
      rule({
        id: 'r_deny_inst',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i1' },
        effect: 'deny',
      }),
    );
    const ev = teamMemberJoined('t_other', 'i1');
    expect(filter.canSee({ kind: 'user', userId: 'u1' }, ev)).toBe(false);
  });

  it('comm.registered 解析 address=user:u1 → 可被 user target 命中', () => {
    store.upsert(
      rule({
        id: 'r_deny_u2',
        principal: { kind: 'user', userId: 'u2' },
        target: { kind: 'user', userId: 'u1' },
        effect: 'deny',
      }),
    );
    const ev: CommRegisteredEvent = {
      type: 'comm.registered',
      ts: baseTs,
      source: 'test',
      address: 'user:u1',
    };
    expect(filter.canSee({ kind: 'user', userId: 'u2' }, ev)).toBe(false);
  });

  it('address 解析不了（system / 空）→ default_allow', () => {
    store.upsert(rule({ id: 'r_u1' }));
    const ev: CommRegisteredEvent = {
      type: 'comm.registered',
      ts: baseTs,
      source: 'test',
      address: 'system',
    };
    expect(filter.decide({ kind: 'user', userId: 'u1' }, ev)).toEqual({
      decision: 'allow',
      byRuleId: 'default_allow',
    });
  });
});

// ---------------------------------------------------------------------------
// R2-5 运行期 upsert 立即生效
// ---------------------------------------------------------------------------
describe('不缓存：运行期 upsert/remove 立即生效', () => {
  it('建好 filter 后再 upsert → 立即 deny', () => {
    const u1: ActorPrincipal = { kind: 'user', userId: 'u1' };
    const ev = driverText('i_new');
    expect(filter.canSee(u1, ev)).toBe(true); // 无规则
    store.upsert(
      rule({
        id: 'r_live',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i_new' },
        effect: 'deny',
      }),
    );
    expect(filter.canSee(u1, ev)).toBe(false);
  });

  it('remove 后回到 default_allow', () => {
    store.upsert(
      rule({
        id: 'r_live_2',
        principal: { kind: 'user', userId: 'u1' },
        target: { kind: 'agent', instanceId: 'i_x' },
        effect: 'deny',
      }),
    );
    const u1: ActorPrincipal = { kind: 'user', userId: 'u1' };
    const ev = driverText('i_x');
    expect(filter.canSee(u1, ev)).toBe(false);
    store.remove('r_live_2');
    expect(filter.decide(u1, ev)).toEqual({
      decision: 'allow',
      byRuleId: 'default_allow',
    });
  });
});

// ---------------------------------------------------------------------------
// system principal
// ---------------------------------------------------------------------------
describe('system principal', () => {
  it('system 主体 + system 规则 deny → deny', () => {
    store.upsert(
      rule({
        id: 'r_sys',
        principal: { kind: 'system' },
        target: { kind: 'agent', instanceId: 'iZ' },
        effect: 'deny',
      }),
    );
    expect(
      filter.canSee({ kind: 'system' }, driverText('iZ')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 非业务静态检查（README 要求）
// ---------------------------------------------------------------------------
describe('visibility-filter 模块纯净性', () => {
  it('不 import bus / comm 运行时代码（import type 允许）', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const target = path.resolve(
      path.dirname(here),
      '..',
      'visibility-filter.ts',
    );
    const src = await fs.readFile(target, 'utf8');
    // 运行时 import 禁用（`import type` 开头不算）
    const lines = src.split('\n');
    const bad = lines.filter(
      (l) =>
        /^\s*import\s+(?!type\b)[^;]*from\s+['"][^'"]*\/(bus|comm)\//.test(l),
    );
    expect(bad).toEqual([]);
  });
});

// 抑制未使用变量告警
const _bus: BusEvent = {
  type: 'cli.unavailable',
  ts: baseTs,
  source: 'test',
  cliName: 'x',
};
void _bus;
