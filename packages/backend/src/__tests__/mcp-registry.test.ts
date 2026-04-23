// Unit 测试：mcp/tools/registry.ts 角色过滤
// 纯逻辑测试，不起子进程。覆盖 visibleTools / findTool / leaderOnly。

import { describe, it, expect, afterAll } from 'bun:test';
import { ALL_TOOLS, findTool, visibleTools } from '../mcp/tools/registry.js';
import { readEnv } from '../mcp/config.js';

describe('mcp tools registry', () => {
  it('exposes 6 tools total', () => {
    expect(ALL_TOOLS).toHaveLength(6);
  });

  it('every entry has schema.name / description / inputSchema', () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.schema.name).toBe('string');
      expect(t.schema.name.length).toBeGreaterThan(0);
      expect(typeof t.schema.description).toBe('string');
      expect(typeof t.schema.inputSchema).toBe('object');
      expect(typeof t.handler).toBe('function');
      expect(typeof t.leaderOnly).toBe('boolean');
    }
  });

  it('tool names are unique', () => {
    const names = ALL_TOOLS.map((t) => t.schema.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only request_offline is leaderOnly', () => {
    const leaderOnlyNames = ALL_TOOLS.filter((t) => t.leaderOnly).map(
      (t) => t.schema.name,
    );
    expect(leaderOnlyNames).toEqual(['request_offline']);
  });

  it('visibleTools(false) hides leader-only tools', () => {
    const names = visibleTools(false).map((t) => t.schema.name);
    expect(names).not.toContain('request_offline');
    expect(names).toContain('activate');
    expect(names).toContain('send_msg');
    expect(names).toHaveLength(5);
  });

  it('visibleTools(true) includes all tools', () => {
    const names = visibleTools(true).map((t) => t.schema.name);
    expect(names).toContain('request_offline');
    expect(names).toHaveLength(6);
  });

  it('findTool returns entry by name', () => {
    const entry = findTool('activate');
    expect(entry).toBeDefined();
    expect(entry?.schema.name).toBe('activate');
  });

  it('findTool returns undefined for unknown name', () => {
    expect(findTool('nope')).toBeUndefined();
  });
});

describe('mcp config readEnv isLeader', () => {
  const originalInstance = process.env.ROLE_INSTANCE_ID;
  const originalLeader = process.env.IS_LEADER;

  afterAll(() => {
    if (originalInstance === undefined) delete process.env.ROLE_INSTANCE_ID;
    else process.env.ROLE_INSTANCE_ID = originalInstance;
    if (originalLeader === undefined) delete process.env.IS_LEADER;
    else process.env.IS_LEADER = originalLeader;
  });

  it('isLeader=true when IS_LEADER=1', () => {
    process.env.ROLE_INSTANCE_ID = 'test-instance';
    process.env.IS_LEADER = '1';
    expect(readEnv().isLeader).toBe(true);
  });

  it('isLeader=false when IS_LEADER unset', () => {
    process.env.ROLE_INSTANCE_ID = 'test-instance';
    delete process.env.IS_LEADER;
    expect(readEnv().isLeader).toBe(false);
  });

  it('isLeader=false when IS_LEADER=0', () => {
    process.env.ROLE_INSTANCE_ID = 'test-instance';
    process.env.IS_LEADER = '0';
    expect(readEnv().isLeader).toBe(false);
  });
});
