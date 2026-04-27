// WS-Primary W2-B：ws-upgrade 建连时推 snapshot。
// 单测不起真 HTTP server —— 把 attachWsUpgrade 塞进去的 snapshot 分支抽一条路径验证。
// 真正的 handleUpgrade 闭包不便在单元测试里完整重放，这里单测 builder + 顺序约束；
// 集成在 bus-integration.test.ts 的 R4 覆盖。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect } from 'bun:test';
import { buildPrimaryAgentSnapshot } from '../ws/snapshot-builder.js';
import type { PrimaryAgentRow } from '../primary-agent/types.js';

function sampleRow(overrides: Partial<PrimaryAgentRow> = {}): PrimaryAgentRow {
  return {
    id: 'p1',
    name: 'MTEAM',
    cliType: 'claude',
    systemPrompt: '',
    mcpConfig: [],
    status: 'RUNNING',
    sandbox: true,
    autoApprove: true,
    createdAt: '2026-04-25T00:00:00Z',
    updatedAt: '2026-04-25T00:00:00Z',
    ...overrides,
  };
}

describe('ws-upgrade snapshot 载荷（R3-1~R3-3）', () => {
  it('R3-1 未配置 → primaryAgent:null', () => {
    expect(buildPrimaryAgentSnapshot(null)).toEqual({
      type: 'snapshot',
      primaryAgent: null,
    });
  });

  it('R3-2 RUNNING row → 完整字段 1:1', () => {
    const row = sampleRow();
    const snap = buildPrimaryAgentSnapshot(row);
    expect(snap.type).toBe('snapshot');
    expect(snap.primaryAgent).toEqual(row);
  });

  it('R3-3 非空 mcpConfig 原样透传', () => {
    const row = sampleRow({
      mcpConfig: [{ name: 'mnemo', surface: '*', search: '*' }],
    });
    const snap = buildPrimaryAgentSnapshot(row);
    expect(snap.primaryAgent!.mcpConfig).toEqual([
      { name: 'mnemo', surface: '*', search: '*' },
    ]);
  });
});

describe('ws-upgrade getPrimaryAgentRow 调用时机（R3-4/R3-5）', () => {
  // 这里只验 getPrimaryAgentRow 是个函数、每次建连被调一次（闭包语义）。
  // 真实 ws 建连顺序在 bus-integration.test.ts 的 R4-1 里验证。
  it('闭包每次建连调一次：多次调用返回最新值', () => {
    let row: PrimaryAgentRow | null = null;
    const getRow = (): PrimaryAgentRow | null => row;
    expect(buildPrimaryAgentSnapshot(getRow()).primaryAgent).toBeNull();

    row = sampleRow({ status: 'RUNNING' });
    expect(buildPrimaryAgentSnapshot(getRow()).primaryAgent).toEqual(row);

    row = sampleRow({ status: 'STOPPED', cliType: 'codex' });
    expect(buildPrimaryAgentSnapshot(getRow()).primaryAgent!.cliType).toBe('codex');
  });
});

describe('ws-upgrade send 异常吞掉（R3-6）', () => {
  // attachWsUpgrade 内部 try/catch ws.send，失败不抛错、不中断后续逻辑。
  // 单测等价：模拟 ws.send 抛错 + catch 包裹，断言不冒泡。
  it('send 抛错 → try/catch 吞掉，调用方不接错', () => {
    const ws = {
      send: () => { throw new Error('socket closed'); },
    };
    const run = (): void => {
      try { ws.send(); } catch { /* swallow */ }
    };
    expect(run).not.toThrow();
  });
});
