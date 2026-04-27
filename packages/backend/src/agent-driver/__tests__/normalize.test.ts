// normalize.ts 单测：ACP 原始 → turn-types 归一形状。
// 纯函数，零依赖（不碰 bus/db/driver），断言覆盖 happy path + 脏数据 + 脏厂商差异。
import { describe, it, expect } from 'bun:test';
import {
  contentBlockToAcpContent, toolCallContentToAcpContent, compactAcpContent,
  extractContentText,
  normalizePlanEntries, normalizeCommands, normalizeConfigOptions, normalizeLocations,
  mapToolKind, mapToolStatus,
  normalizeToolInput, normalizeToolOutput,
} from '../normalize.js';

describe('contentBlockToAcpContent', () => {
  it('text / image / audio / resource_link 形状对齐', () => {
    expect(contentBlockToAcpContent({ type: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(contentBlockToAcpContent({ type: 'image', data: 'b64', mimeType: 'image/png' }))
      .toEqual({ kind: 'image', data: 'b64', mimeType: 'image/png' });
    expect(contentBlockToAcpContent({ type: 'audio', data: 'b64', mimeType: 'audio/mp3' }))
      .toEqual({ kind: 'audio', data: 'b64', mimeType: 'audio/mp3' });
    expect(contentBlockToAcpContent({ type: 'resource_link', uri: 'file:///a', name: 'a.txt', mimeType: 'text/plain' }))
      .toEqual({ kind: 'resource_link', uri: 'file:///a', name: 'a.txt', mimeType: 'text/plain' });
  });

  it('resource_link 缺 mimeType → 不写入字段', () => {
    expect(contentBlockToAcpContent({ type: 'resource_link', uri: 'u', name: 'n' }))
      .toEqual({ kind: 'resource_link', uri: 'u', name: 'n' });
  });

  it('脏数据一律 null：非对象 / 未知 type / 字段缺失或类型错', () => {
    expect(contentBlockToAcpContent(null)).toBeNull();
    expect(contentBlockToAcpContent('str')).toBeNull();
    expect(contentBlockToAcpContent({ type: 'resource' })).toBeNull();
    expect(contentBlockToAcpContent({ type: 'text', text: 42 })).toBeNull();
    expect(contentBlockToAcpContent({ type: 'image', data: 'b64' })).toBeNull();
    expect(contentBlockToAcpContent({ type: 'resource_link', uri: 'u' })).toBeNull();
  });
});

describe('toolCallContentToAcpContent', () => {
  it('type=content → 解包 ContentBlock', () => {
    expect(toolCallContentToAcpContent({ type: 'content', content: { type: 'text', text: 'x' } }))
      .toEqual({ kind: 'text', text: 'x' });
  });

  it('type=diff 必要字段齐 → 保留 oldText（可选）', () => {
    expect(toolCallContentToAcpContent({ type: 'diff', path: '/a', newText: 'new' }))
      .toEqual({ kind: 'diff', path: '/a', newText: 'new' });
    expect(toolCallContentToAcpContent({ type: 'diff', path: '/a', newText: 'new', oldText: 'old' }))
      .toEqual({ kind: 'diff', path: '/a', newText: 'new', oldText: 'old' });
  });

  it('type=diff newText 允许空串但不允许缺失', () => {
    expect(toolCallContentToAcpContent({ type: 'diff', path: '/a', newText: '' }))
      .toEqual({ kind: 'diff', path: '/a', newText: '' });
    expect(toolCallContentToAcpContent({ type: 'diff', path: '/a' })).toBeNull();
  });

  it('type=terminal + terminalId → 保留', () => {
    expect(toolCallContentToAcpContent({ type: 'terminal', terminalId: 'term-1' }))
      .toEqual({ kind: 'terminal', terminalId: 'term-1' });
    expect(toolCallContentToAcpContent({ type: 'terminal' })).toBeNull();
  });

  it('未知 type / 非对象 → null', () => {
    expect(toolCallContentToAcpContent({ type: 'whatever' })).toBeNull();
    expect(toolCallContentToAcpContent(undefined)).toBeNull();
  });
});

describe('compactAcpContent', () => {
  it('数组里 null / 坏元素被类型守卫滤掉，返回 AcpContent[]（不是 (AcpContent|null)[]）', () => {
    const result = compactAcpContent([
      { type: 'content', content: { type: 'text', text: 'a' } },
      { type: 'unknown' },
      null,
      { type: 'terminal', terminalId: 't1' },
    ]);
    expect(result).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'terminal', terminalId: 't1' },
    ]);
  });

  it('非数组 → 空数组', () => {
    expect(compactAcpContent(null)).toEqual([]);
    expect(compactAcpContent({})).toEqual([]);
    expect(compactAcpContent(undefined)).toEqual([]);
  });
});

describe('extractContentText', () => {
  it('单块 text → 文本；非 text 忽略', () => {
    expect(extractContentText({ type: 'text', text: 'hi' })).toBe('hi');
    expect(extractContentText({ type: 'image', data: 'b64' })).toBe('');
  });

  it('数组内多块 text 顺序拼接；非 text 块跳过', () => {
    expect(extractContentText([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'b64', mimeType: 'image/png' },
      { type: 'text', text: 'b' },
    ])).toBe('ab');
  });

  it('脏输入 → 空串', () => {
    expect(extractContentText(null)).toBe('');
    expect(extractContentText(undefined)).toBe('');
    expect(extractContentText('plain')).toBe('');
  });
});

describe('normalizePlanEntries', () => {
  it('合法 + priority/status 缺省走默认', () => {
    expect(normalizePlanEntries([
      { content: 'a', priority: 'high', status: 'completed' },
      { content: 'b' },
    ])).toEqual([
      { content: 'a', priority: 'high', status: 'completed' },
      { content: 'b', priority: 'medium', status: 'pending' },
    ]);
  });

  it('非法 priority/status 走默认，不抛', () => {
    expect(normalizePlanEntries([{ content: 'a', priority: 'xxx', status: 'yyy' }]))
      .toEqual([{ content: 'a', priority: 'medium', status: 'pending' }]);
  });

  it('缺 content → 丢弃该条；非数组 → 空数组', () => {
    expect(normalizePlanEntries([{ priority: 'high' }, { content: 'ok' }]))
      .toEqual([{ content: 'ok', priority: 'medium', status: 'pending' }]);
    expect(normalizePlanEntries(null)).toEqual([]);
  });
});

describe('normalizeCommands', () => {
  it('name 必填；description 缺省空串；inputHint 可选保留', () => {
    expect(normalizeCommands([
      { name: '/help', description: '显示帮助' },
      { name: '/run', inputHint: 'ARGS' },
      { description: '缺 name 会丢' },
    ])).toEqual([
      { name: '/help', description: '显示帮助' },
      { name: '/run', description: '', inputHint: 'ARGS' },
    ]);
  });
});

describe('normalizeConfigOptions', () => {
  it('完整 thought_level 选项保留 options 数组', () => {
    expect(normalizeConfigOptions([{
      id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium',
      options: [
        { id: 'low', name: 'Low', description: '快但浅' },
        { id: 'high', name: 'High' },
        { name: '缺 id' }, // 被滤
      ],
    }])).toEqual([{
      id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium',
      options: [
        { id: 'low', name: 'Low', description: '快但浅' },
        { id: 'high', name: 'High' },
      ],
    }]);
  });

  it('非法 category/type 或 currentValue 类型错 → 丢弃', () => {
    expect(normalizeConfigOptions([
      { id: 'a', category: 'unknown', type: 'select', currentValue: 'x' },
      { id: 'b', category: 'mode', type: 'unknown', currentValue: 'x' },
      { id: 'c', category: 'mode', type: 'select', currentValue: { nested: 1 } },
    ])).toEqual([]);
  });

  it('toggle + boolean + 无 options', () => {
    expect(normalizeConfigOptions([{ id: 'flag', category: 'model', type: 'toggle', currentValue: true }]))
      .toEqual([{ id: 'flag', category: 'model', type: 'toggle', currentValue: true }]);
  });
});

describe('normalizeLocations', () => {
  it('多条 + 可选 line；全部非法 → undefined', () => {
    expect(normalizeLocations([{ path: '/a', line: 10 }, { path: '/b' }, { line: 1 }]))
      .toEqual([{ path: '/a', line: 10 }, { path: '/b' }]);
    expect(normalizeLocations([{ nope: 1 }])).toBeUndefined();
    expect(normalizeLocations(null)).toBeUndefined();
  });
});

describe('mapToolKind / mapToolStatus', () => {
  it('mapToolKind 只接受白名单字面量', () => {
    expect(mapToolKind('read')).toBe('read');
    expect(mapToolKind('unknown')).toBeUndefined();
    expect(mapToolKind(42)).toBeUndefined();
  });

  it('mapToolStatus 非白名单 → pending', () => {
    expect(mapToolStatus('in_progress')).toBe('in_progress');
    expect(mapToolStatus('completed')).toBe('completed');
    expect(mapToolStatus('weird')).toBe('pending');
    expect(mapToolStatus(undefined)).toBe('pending');
  });
});

describe('normalizeToolInput', () => {
  it('claude rawInput 有 file_path → display="title: file_path"', () => {
    const p = normalizeToolInput('claude', 'Read', { file_path: '/tmp/a.txt', offset: 0 });
    expect(p.vendor).toBe('claude');
    expect(p.display).toBe('Read: /tmp/a.txt');
    expect(p.data).toEqual({ file_path: '/tmp/a.txt', offset: 0 });
  });

  it('claude rawInput.command 或 path 作为退路', () => {
    expect(normalizeToolInput('claude', 'Bash', { command: 'ls' }).display).toBe('Bash: ls');
    expect(normalizeToolInput('claude', '', { path: '/x' }).display).toBe('/x');
  });

  it('claude 无识别字段 → display=title', () => {
    expect(normalizeToolInput('claude', 'Unknown', { foo: 'bar' }).display).toBe('Unknown');
    expect(normalizeToolInput('claude', 'T', null).display).toBe('T');
  });

  it('codex parsed_cmd[0].cmd 优先（unified_exec 形状）', () => {
    const p = normalizeToolInput('codex', 'Read x.txt', {
      command: ['/bin/zsh', '-lc', 'cat /tmp/x.txt'],
      cwd: '/tmp',
      parsed_cmd: [{ type: 'read', cmd: 'cat /tmp/x.txt', path: '/tmp/x.txt' }],
    });
    expect(p.vendor).toBe('codex');
    expect(p.display).toBe('cat /tmp/x.txt');
  });

  it('codex parsed_cmd 缺 → 取 command 数组末元素', () => {
    expect(normalizeToolInput('codex', 'T', { command: ['/bin/sh', '-c', 'echo hi'] }).display).toBe('echo hi');
  });

  it('codex 什么都没有 → title', () => {
    expect(normalizeToolInput('codex', 'T', {}).display).toBe('T');
  });

  it('rawInput null → data=null 但保留，display 退化到 title', () => {
    expect(normalizeToolInput('codex', 'T', null)).toEqual({ vendor: 'codex', display: 'T', data: null });
  });
});

describe('normalizeToolOutput', () => {
  it('codex formatted_output 优先，exitCode 抽出', () => {
    const o = normalizeToolOutput('codex', {
      stdout: 'hello\n', stderr: '', exit_code: 0,
      formatted_output: 'hello\n', aggregated_output: 'hello\n',
    });
    expect(o.vendor).toBe('codex');
    expect(o.display).toBe('hello\n');
    expect(o.exitCode).toBe(0);
  });

  it('codex 无 exit_code → exitCode 缺省不写入', () => {
    const o = normalizeToolOutput('codex', { formatted_output: 'x' });
    expect(o.exitCode).toBeUndefined();
  });

  it('codex aggregated_output 退路', () => {
    expect(normalizeToolOutput('codex', { aggregated_output: 'a' }).display).toBe('a');
    expect(normalizeToolOutput('codex', {}).display).toBe('');
  });

  it('claude 字符串 rawOutput 直接当 display；exitCode 永远不写', () => {
    const o = normalizeToolOutput('claude', 'file content');
    expect(o.vendor).toBe('claude');
    expect(o.display).toBe('file content');
    expect(o.exitCode).toBeUndefined();
  });

  it('claude object.content 作为 display 退路', () => {
    expect(normalizeToolOutput('claude', { content: 'ok' }).display).toBe('ok');
    expect(normalizeToolOutput('claude', { other: 1 }).display).toBe('');
  });

  it('rawOutput null → data=null', () => {
    expect(normalizeToolOutput('claude', null)).toEqual({ vendor: 'claude', display: '', data: null });
  });
});
