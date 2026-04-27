// CodexAdapter.parseUpdate —— ACP 11 种 sessionUpdate 分支覆盖。
// 对照 docs/phase-ws/turn-aggregator-design.md §2.3 / §3.3 与
// docs/phase-ws/acp-codex-messages.md §2。不 mock，跑真实 parseUpdate。
import { describe, it, expect } from 'bun:test';
import { CodexAdapter } from '../adapters/codex.js';

const a = new CodexAdapter();

describe('CodexAdapter.parseUpdate · agent_message_chunk / agent_thought_chunk', () => {
  it('agent_message_chunk → driver.text；无 messageId 字段不出现', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I' },
    });
    expect(ev).toEqual({ type: 'driver.text', content: 'I' });
  });

  it('agent_message_chunk + messageId → driver.text 带 messageId', () => {
    expect(a.parseUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_01',
      content: { type: 'text', text: 'hi' },
    })).toEqual({ type: 'driver.text', messageId: 'msg_01', content: 'hi' });
  });

  it('agent_thought_chunk → driver.thinking', () => {
    expect(a.parseUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'r' },
    })).toEqual({ type: 'driver.thinking', content: 'r' });
  });

  it('agent_message_chunk content 数组多 text → 顺序拼接', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'b64', mimeType: 'image/png' },
        { type: 'text', text: 'b' },
      ],
    });
    expect((ev as { content: string }).content).toBe('ab');
  });
});

describe('CodexAdapter.parseUpdate · tool_call（Codex unified_exec 形状）', () => {
  it('完整 Codex payload（initial status=in_progress，rawInput 带 parsed_cmd）→ driver.tool_call 填全 title/kind/status/locations + VendorPayload.input', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_abc',
      title: 'Read hostname',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/etc/hostname' }],
      rawInput: {
        call_id: 'call_abc',
        process_id: '65818',
        turn_id: 'turn_001',
        command: ['/opt/homebrew/bin/zsh', '-lc', 'cat /etc/hostname'],
        cwd: '/tmp',
        parsed_cmd: [{ type: 'read', cmd: 'cat /etc/hostname', path: '/etc/hostname' }],
        source: 'unified_exec_startup',
      },
    });
    expect(ev).toEqual({
      type: 'driver.tool_call',
      toolCallId: 'call_abc',
      name: 'Read hostname',
      title: 'Read hostname',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/etc/hostname' }],
      input: {
        vendor: 'codex',
        display: 'cat /etc/hostname',
        data: {
          call_id: 'call_abc',
          process_id: '65818',
          turn_id: 'turn_001',
          command: ['/opt/homebrew/bin/zsh', '-lc', 'cat /etc/hostname'],
          cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat /etc/hostname', path: '/etc/hostname' }],
          source: 'unified_exec_startup',
        },
      },
    });
  });

  it('缺 parsed_cmd → display 退化到 command 数组末元素', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_x',
      title: 'T',
      rawInput: { command: ['/bin/sh', '-c', 'echo hi'] },
    });
    expect((ev as { input: { display: string } }).input.display).toBe('echo hi');
  });

  it('缺 toolCallId → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'tool_call', title: 'x' })).toBeNull();
  });

  it('缺 status → pending 兜底（mapToolStatus 白名单）；非白名单 kind 不写入', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'T',
      kind: 'garbage',
      rawInput: {},
    });
    expect((ev as { status: string; kind?: string }).status).toBe('pending');
    expect((ev as { kind?: string }).kind).toBeUndefined();
  });
});

describe('CodexAdapter.parseUpdate · tool_call_update（rawOutput 含 stdout/exit_code）', () => {
  it('status=failed + rawOutput → driver.tool_update 带 VendorOutput.exitCode', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_abc',
      status: 'failed',
      rawOutput: {
        stdout: 'cat: /etc/hostname: No such file or directory\n',
        stderr: '',
        aggregated_output: 'cat: /etc/hostname: No such file or directory\n',
        exit_code: 1,
        duration: { secs: 0, nanos: 51935000 },
        formatted_output: 'cat: /etc/hostname: No such file or directory\n',
      },
    });
    expect(ev).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'call_abc',
      status: 'failed',
      output: {
        vendor: 'codex',
        display: 'cat: /etc/hostname: No such file or directory\n',
        exitCode: 1,
        data: {
          stdout: 'cat: /etc/hostname: No such file or directory\n',
          stderr: '',
          aggregated_output: 'cat: /etc/hostname: No such file or directory\n',
          exit_code: 1,
          duration: { secs: 0, nanos: 51935000 },
          formatted_output: 'cat: /etc/hostname: No such file or directory\n',
        },
      },
    });
  });

  it('status=in_progress 中间态 → 也产出 driver.tool_update（不再被丢弃）', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c2',
      status: 'in_progress',
    });
    expect(ev).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'c2',
      status: 'in_progress',
    });
  });

  it('仅 status + title/kind/locations → 全量透传归一字段', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c3',
      status: 'completed',
      title: 'Updated Title',
      kind: 'execute',
      locations: [{ path: '/tmp/a', line: 2 }, { nope: 1 }],
    });
    expect(ev).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'c3',
      status: 'completed',
      title: 'Updated Title',
      kind: 'execute',
      locations: [{ path: '/tmp/a', line: 2 }],
    });
  });

  it('rawOutput=null → output 写入（data=null, exitCode 缺省不写）', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c4',
      status: 'completed',
      rawOutput: null,
    });
    expect(ev).toEqual({
      type: 'driver.tool_update',
      toolCallId: 'c4',
      status: 'completed',
      output: { vendor: 'codex', display: '', data: null },
    });
  });

  it('ACP content 存在（Codex 实测不发，SDK 允许）→ 通过 compactAcpContent 归一', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c5',
      content: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'unknown' },
      ],
    });
    expect((ev as { content?: unknown }).content).toEqual([{ kind: 'text', text: 'ok' }]);
  });

  it('缺 toolCallId → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'tool_call_update', status: 'completed' })).toBeNull();
  });
});

describe('CodexAdapter.parseUpdate · plan（Codex 不发但 SDK 允许）', () => {
  it('entries 归一到 driver.plan；非法项被滤', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', priority: 'high', status: 'completed' },
        { content: 'b' },
        { priority: 'low' }, // 被滤
      ],
    });
    expect(ev).toEqual({
      type: 'driver.plan',
      entries: [
        { content: 'a', priority: 'high', status: 'completed' },
        { content: 'b', priority: 'medium', status: 'pending' },
      ],
    });
  });
});

describe('CodexAdapter.parseUpdate · available_commands_update（Codex session/new 后立即发）', () => {
  it('7 条 slash-command 归一 → driver.commands', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review my current changes', input: { hint: 'h' } },
        { name: 'compact', description: 'summarize', input: null },
        { description: '缺 name 被滤' },
      ],
    });
    expect(ev).toEqual({
      type: 'driver.commands',
      commands: [
        { name: 'review', description: 'Review my current changes' },
        { name: 'compact', description: 'summarize' },
      ],
    });
  });
});

describe('CodexAdapter.parseUpdate · current_mode_update', () => {
  it('currentModeId 非空 → driver.mode', () => {
    expect(a.parseUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'read-only' }))
      .toEqual({ type: 'driver.mode', currentModeId: 'read-only' });
  });

  it('currentModeId 缺失 → null（不产空事件）', () => {
    expect(a.parseUpdate({ sessionUpdate: 'current_mode_update' })).toBeNull();
  });
});

describe('CodexAdapter.parseUpdate · config_option_update（Codex thought_level）', () => {
  it('reasoning_effort thought_level select 归一', () => {
    const ev = a.parseUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High', description: '深思' },
          ],
        },
        {
          id: 'bad', category: 'unknown', type: 'select', currentValue: 'x', // 被滤
        },
      ],
    });
    expect(ev).toEqual({
      type: 'driver.config',
      options: [{
        id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium',
        options: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High', description: '深思' },
        ],
      }],
    });
  });
});

describe('CodexAdapter.parseUpdate · session_info_update', () => {
  it('title + updatedAt 透传', () => {
    expect(a.parseUpdate({
      sessionUpdate: 'session_info_update',
      title: '会话标题',
      updatedAt: '2026-04-25T12:00:00Z',
    })).toEqual({
      type: 'driver.session_info',
      title: '会话标题',
      updatedAt: '2026-04-25T12:00:00Z',
    });
  });

  it('全空字段 → 仍产 driver.session_info 空负载', () => {
    expect(a.parseUpdate({ sessionUpdate: 'session_info_update' }))
      .toEqual({ type: 'driver.session_info' });
  });
});

describe('CodexAdapter.parseUpdate · usage_update（Codex 每 turn 发）', () => {
  it('used/size 完整 → driver.usage（Codex 实测不带 cost）', () => {
    expect(a.parseUpdate({ sessionUpdate: 'usage_update', used: 8284, size: 258400 }))
      .toEqual({ type: 'driver.usage', used: 8284, size: 258400 });
  });

  it('cost 对象合法 → 透传', () => {
    expect(a.parseUpdate({
      sessionUpdate: 'usage_update',
      used: 1, size: 2,
      cost: { amount: 0.001, currency: 'USD' },
    })).toEqual({
      type: 'driver.usage', used: 1, size: 2,
      cost: { amount: 0.001, currency: 'USD' },
    });
  });

  it('used 非数字 → null（脏数据不产出坏事件）', () => {
    expect(a.parseUpdate({ sessionUpdate: 'usage_update', used: 'lots', size: 1 })).toBeNull();
    expect(a.parseUpdate({ sessionUpdate: 'usage_update', size: 1 })).toBeNull();
  });
});

describe('CodexAdapter.parseUpdate · user_message_chunk / 未知', () => {
  it('user_message_chunk → null（Codex 实测不发，暂不映射）', () => {
    expect(a.parseUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }))
      .toBeNull();
  });

  it('未知 sessionUpdate / 非对象 / 空对象 → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'whatever' })).toBeNull();
    expect(a.parseUpdate(null)).toBeNull();
    expect(a.parseUpdate(undefined)).toBeNull();
    expect(a.parseUpdate('str')).toBeNull();
    expect(a.parseUpdate({})).toBeNull();
  });
});
