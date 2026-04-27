import { describe, it, expect } from 'bun:test';
import { formatNotifyLine, formatMemberMessage } from './format-message.js';

const NOTIFY_RE = /^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$/;

describe('formatNotifyLine', () => {
  it('U-120 精确格式 @<name>>${summary}  [msg_id=<id>]', () => {
    const out = formatNotifyLine({
      envelopeId: 'msg_abc123',
      fromDisplayName: 'Alice',
      summary: '帮我看下 bug',
    });
    expect(out).toBe('@Alice>帮我看下 bug  [msg_id=msg_abc123]');
  });

  it('U-121 正则断言：100 条随机数据全部匹配', () => {
    const names = ['alice', '王老师', 'Bob-1', '系统', 'A_B.C'];
    const summaries = ['hi', '开会', 'stack trace 在这里', '  含空格  ', '带:冒号'];
    for (let i = 0; i < 100; i += 1) {
      const id = `msg_${Math.random().toString(36).slice(2, 10)}_${i}`;
      const name = names[i % names.length]!;
      const summary = summaries[i % summaries.length]!;
      const line = formatNotifyLine({ envelopeId: id, fromDisplayName: name, summary });
      expect(line).toMatch(NOTIFY_RE);
    }
  });

  it('system 来源也走同一格式（name=系统）', () => {
    const line = formatNotifyLine({
      envelopeId: 'msg_sys1',
      fromDisplayName: '系统',
      summary: 'leader approved offline',
    });
    expect(line).toBe('@系统>leader approved offline  [msg_id=msg_sys1]');
    expect(line).toMatch(NOTIFY_RE);
  });
});

describe('formatMemberMessage (shim)', () => {
  it('U-122 旧签名仍能调；返回新 notify 格式', () => {
    const out = formatMemberMessage({
      from: 'local:alice',
      kind: 'chat',
      summary: 'hello',
      content: 'world',
    });
    expect(out).toMatch(NOTIFY_RE);
    expect(out).toContain('@alice>hello');
    expect(out).toContain('[msg_id=msg_legacy]');
  });

  it('shim 不再渲染 content / action（老格式已废）', () => {
    const out = formatMemberMessage({
      from: 'local:system',
      kind: 'system',
      summary: 'deactivated',
      action: 'deactivate',
    });
    expect(out).toBe('@system>deactivated  [msg_id=msg_legacy]');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('[系统消息]');
  });
});
