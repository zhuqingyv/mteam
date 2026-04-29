// registry 集成守卫：验证每个工具通过 handler(deps, args) 调用不炸。
// 防止注册时参数错位（如 send_to_agent 缺 comm 导致 args.kind undefined）。
import { describe, it, expect } from 'bun:test';
import { ALL_TOOLS, findTool } from './registry.js';

describe('mcp-primary registry 集成守卫', () => {
  it('ALL_TOOLS 包含 7 个工具', () => {
    expect(ALL_TOOLS.length).toBe(7);
  });

  it('每个工具的 schema.name 唯一', () => {
    const names = ALL_TOOLS.map((t) => t.schema.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('findTool 能找到每个已注册工具', () => {
    const expected = [
      'create_leader', 'send_to_agent', 'list_addresses',
      'get_team_status', 'search_settings', 'call_setting', 'launch_workflow',
    ];
    for (const name of expected) {
      expect(findTool(name)).toBeDefined();
    }
  });

  it('每个 handler 传空 args 不抛 TypeError（参数错位守卫）', async () => {
    const fakeDeps = {
      env: { instanceId: 'test-id', hubUrl: 'http://localhost:1' },
      comm: { send: async () => ({ ok: true }) },
    };
    for (const tool of ALL_TOOLS) {
      // 用空 args 调用，期望返回 error 对象而不是 TypeError
      const result = await tool.handler(fakeDeps as any, {});
      // 不管返回什么，只要不抛 TypeError 就算过
      expect(result).toBeDefined();
    }
  });
});
