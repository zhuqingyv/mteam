// ClaudeAdapter.parseUpdate 11 种 sessionUpdate 分支覆盖。
// 不 mock：直接构造 ACP payload 丢给纯函数 parseUpdate，断言产出的 DriverEvent 形状。
// 合约见 docs/phase-ws/turn-aggregator-design.md §3.2。
import { describe, it, expect } from 'bun:test';
import { ClaudeAdapter } from '../agent-driver/adapters/claude.js';

const a = new ClaudeAdapter();

describe('ClaudeAdapter.parseUpdate · agent_thought_chunk', () => {
  it('无 messageId → driver.thinking(content)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '思考中' },
      }),
    ).toEqual({ type: 'driver.thinking', content: '思考中' });
  });

  it('带 messageId → 透传', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'msg_01',
        content: { type: 'text', text: 'r' },
      }),
    ).toEqual({ type: 'driver.thinking', messageId: 'msg_01', content: 'r' });
  });
});

describe('ClaudeAdapter.parseUpdate · agent_message_chunk', () => {
  it('带 messageId → driver.text + messageId', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_02',
        content: { type: 'text', text: '你好' },
      }),
    ).toEqual({ type: 'driver.text', messageId: 'msg_02', content: '你好' });
  });

  it('无 content.text → content 为空串', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'x', mimeType: 'image/png' },
      }),
    ).toEqual({ type: 'driver.text', content: '' });
  });
});

describe('ClaudeAdapter.parseUpdate · tool_call', () => {
  it('完整字段 → driver.tool_call 带 title/kind/status/locations/input(VendorPayload)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        locations: [{ path: '/a', line: 3 }],
        rawInput: { file_path: '/a' },
      }),
    ).toEqual({
      type: 'driver.tool_call',
      toolCallId: 'tc-1',
      name: 'Read', // 过渡期老字段
      title: 'Read',
      status: 'pending',
      kind: 'read',
      locations: [{ path: '/a', line: 3 }],
      input: { vendor: 'claude', display: 'Read: /a', data: { file_path: '/a' } },
    });
  });

  it('无 title/status → name fallback=tool, status=pending, title 空串', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-x',
      rawInput: { command: 'ls' },
    });
    expect(ev).toMatchObject({
      type: 'driver.tool_call',
      toolCallId: 'tc-x',
      name: 'tool',
      title: '',
      status: 'pending',
      input: { vendor: 'claude', display: 'ls', data: { command: 'ls' } },
    });
  });

  it('带 content(diff) → 透传 AcpContent', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'Edit',
      rawInput: { file_path: '/x' },
      content: [{ type: 'diff', path: '/x', newText: 'new', oldText: 'old' }],
    }) as { content?: unknown[] };
    expect(ev.content).toEqual([
      { kind: 'diff', path: '/x', newText: 'new', oldText: 'old' },
    ]);
  });

  it('非法 kind → 丢掉', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-k',
      title: 'x',
      kind: 'nonsense',
      rawInput: {},
    }) as unknown as Record<string, unknown>;
    expect('kind' in ev).toBe(false);
  });

  it('非法 locations（空数组）→ 不带 locations 字段', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-l',
      title: 'x',
      locations: [],
      rawInput: {},
    }) as unknown as Record<string, unknown>;
    expect('locations' in ev).toBe(false);
  });

  it('缺 toolCallId → null', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'tool_call', title: 'x' }),
    ).toBeNull();
  });
});

describe('ClaudeAdapter.parseUpdate · tool_call_update', () => {
  it('中间态 in_progress → driver.tool_update (status only)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'in_progress',
      }),
    ).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'tc-1',
      status: 'in_progress',
    });
  });

  it('completed + rawOutput → output 归一为 VendorOutput', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { content: 'hello' },
      }),
    ).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'tc-1',
      status: 'completed',
      output: { vendor: 'claude', display: 'hello', data: { content: 'hello' } },
    });
  });

  it('failed + title/kind/locations/content → 全部透传', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'failed',
        title: 'Read updated',
        kind: 'read',
        locations: [{ path: '/y' }],
        content: [{ type: 'content', content: { type: 'text', text: 'err' } }],
      }),
    ).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'tc-1',
      status: 'failed',
      title: 'Read updated',
      kind: 'read',
      locations: [{ path: '/y' }],
      content: [{ kind: 'text', text: 'err' }],
    });
  });

  it('无 status 字段 → 仍产出 driver.tool_update（status 可选）', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-nos',
      }),
    ).toEqual({ type: 'driver.tool_update', toolCallId: 'tc-nos' });
  });

  it('缺 toolCallId → null', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'tool_call_update', status: 'pending' }),
    ).toBeNull();
  });
});

describe('ClaudeAdapter.parseUpdate · plan', () => {
  it('entries 归一（过滤缺 content 的项）', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'plan',
        entries: [
          { content: 'a', priority: 'high', status: 'in_progress' },
          { content: 'b', priority: 'low', status: 'pending' },
          { not_content: 1 },
        ],
      }),
    ).toEqual({
      type: 'driver.plan',
      entries: [
        { content: 'a', priority: 'high', status: 'in_progress' },
        { content: 'b', priority: 'low', status: 'pending' },
      ],
    });
  });

  it('空 entries → 空数组', () => {
    expect(a.parseUpdate({ sessionUpdate: 'plan' })).toEqual({
      type: 'driver.plan',
      entries: [],
    });
  });
});

describe('ClaudeAdapter.parseUpdate · available_commands_update', () => {
  it('availableCommands → driver.commands', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'init', description: 'Init project' },
          { name: 'fix', description: 'Fix issue', inputHint: 'issue id' },
        ],
      }),
    ).toEqual({
      type: 'driver.commands',
      commands: [
        { name: 'init', description: 'Init project' },
        { name: 'fix', description: 'Fix issue', inputHint: 'issue id' },
      ],
    });
  });
});

describe('ClaudeAdapter.parseUpdate · current_mode_update', () => {
  it('currentModeId → driver.mode', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'plan',
      }),
    ).toEqual({ type: 'driver.mode', currentModeId: 'plan' });
  });

  it('缺 currentModeId → null', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'current_mode_update' }),
    ).toBeNull();
  });
});

describe('ClaudeAdapter.parseUpdate · config_option_update', () => {
  it('configOptions 归一', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'thought',
            category: 'thought_level',
            type: 'select',
            currentValue: 'deep',
            options: [{ id: 'deep', name: 'Deep' }],
          },
        ],
      }),
    ).toEqual({
      type: 'driver.config',
      options: [
        {
          id: 'thought',
          category: 'thought_level',
          type: 'select',
          currentValue: 'deep',
          options: [{ id: 'deep', name: 'Deep' }],
        },
      ],
    });
  });
});

describe('ClaudeAdapter.parseUpdate · session_info_update', () => {
  it('title + updatedAt → 透传', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'session_info_update',
        title: 'My Session',
        updatedAt: '2026-04-25T12:00:00.000Z',
      }),
    ).toEqual({
      type: 'driver.session_info',
      title: 'My Session',
      updatedAt: '2026-04-25T12:00:00.000Z',
    });
  });

  it('全空 → 仅 type', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'session_info_update' }),
    ).toEqual({ type: 'driver.session_info' });
  });

  it('title=null → 不带 title（按缺省处理）', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'session_info_update', title: null }),
    ).toEqual({ type: 'driver.session_info' });
  });
});

describe('ClaudeAdapter.parseUpdate · usage_update', () => {
  it('used/size/cost 全填 → driver.usage', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200000,
        cost: { amount: 0.01, currency: 'USD' },
      }),
    ).toEqual({
      type: 'driver.usage',
      used: 1000,
      size: 200000,
      cost: { amount: 0.01, currency: 'USD' },
    });
  });

  it('无 cost → 不带 cost 字段', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100 }),
    ).toEqual({ type: 'driver.usage', used: 10, size: 100 });
  });

  it('used 类型不对 → null', () => {
    expect(
      a.parseUpdate({ sessionUpdate: 'usage_update', used: 'x', size: 100 }),
    ).toBeNull();
  });

  it('cost 字段不完整 → 不带 cost 字段', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'usage_update',
        used: 1,
        size: 2,
        cost: { amount: 0.1 }, // 缺 currency
      }),
    ).toEqual({ type: 'driver.usage', used: 1, size: 2 });
  });
});

describe('ClaudeAdapter.parseUpdate · user_message_chunk (设计暂不映射)', () => {
  it('→ null', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toBeNull();
  });
});
