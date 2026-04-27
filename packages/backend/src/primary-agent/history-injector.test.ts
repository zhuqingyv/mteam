// history-injector 纯函数单测。无 DB 依赖，只喂 Turn[]。
// 覆盖：空 / 单轮 / 工具摘要 / thinking 丢弃 / 无 output / XML 转义 /
//      user+assistant 截断 / 总字节上限（从最早砍）/ 单轮超限 / 顺序（ASC）。

import { describe, it, expect } from 'bun:test';
import type { Turn, TurnBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../agent-driver/turn-types.js';
import {
  buildHistoryPromptBlock,
  MAX_USER_CHARS,
  MAX_ASSISTANT_CHARS,
  MAX_HISTORY_BYTES,
} from './history-injector.js';

// ---------- helpers ----------

function text(content: string, id = 'b-txt'): TextBlock {
  return {
    blockId: id, type: 'text', scope: 'turn', status: 'done',
    seq: 0, startTs: 't0', updatedTs: 't1', content,
  };
}
function thinking(content: string, id = 'b-think'): ThinkingBlock {
  return {
    blockId: id, type: 'thinking', scope: 'turn', status: 'done',
    seq: 0, startTs: 't0', updatedTs: 't1', content,
  };
}
function toolCall(title: string, inDisp: string, outDisp: string | null, id = 'b-tc'): ToolCallBlock {
  const b: ToolCallBlock = {
    blockId: id, type: 'tool_call', scope: 'turn', status: 'done',
    seq: 0, startTs: 't0', updatedTs: 't1',
    toolCallId: 'tc-' + id, title, toolStatus: 'completed',
    input: { vendor: 'claude', display: inDisp, data: {} },
  };
  if (outDisp !== null) b.output = { vendor: 'claude', display: outDisp, data: {} };
  return b;
}

function turn(turnId: string, userText: string, blocks: TurnBlock[], endTs = '2026-04-25T10:00:01.000Z'): Turn {
  return {
    turnId,
    driverId: 'drv1',
    status: 'done',
    userInput: { text: userText, ts: '2026-04-25T10:00:00.000Z' },
    blocks,
    startTs: '2026-04-25T10:00:00.000Z',
    endTs,
  };
}

// 注意：DB 返回 DESC（最新在前）；这里构造 DESC 输入，函数内部会 reverse 为 ASC。
function desc(...turns: Turn[]): Turn[] {
  return [...turns].reverse();
}

// ---------- cases ----------

describe('buildHistoryPromptBlock', () => {
  it('空 turns → 空串', () => {
    expect(buildHistoryPromptBlock([])).toBe('');
  });

  it('单 Turn 纯 text → 含 past_conversation + 指令行 + turn/user/assistant', () => {
    const out = buildHistoryPromptBlock([turn('T1', '你好', [text('回复内容')])]);
    expect(out).toContain('<past_conversation>');
    expect(out).toContain('</past_conversation>');
    expect(out).toContain('<turn>');
    expect(out).toContain('<user>你好</user>');
    expect(out).toContain('<assistant>回复内容</assistant>');
    expect(out).not.toContain('thinking');
    expect(out).not.toContain('tool_call');
  });

  it('tool_call → <assistant> 末尾追加 [工具 title: input → output] 摘要', () => {
    const out = buildHistoryPromptBlock([
      turn('T1', '列目录', [
        text('结果如下'),
        toolCall('list_files', 'ls /', '3 files'),
      ]),
    ]);
    expect(out).toContain('<assistant>结果如下\n[工具 list_files: ls / → 3 files]</assistant>');
  });

  it('thinking block → 原文不出现在输出里', () => {
    const secret = 'INTERNAL_COT_SHOULD_NOT_LEAK';
    const out = buildHistoryPromptBlock([
      turn('T1', 'q', [thinking(secret), text('visible')]),
    ]);
    expect(out).not.toContain(secret);
    expect(out).toContain('visible');
  });

  it('tool_call 无 output → 摘要显示 (无输出)', () => {
    const out = buildHistoryPromptBlock([
      turn('T1', 'q', [toolCall('run', 'do_stuff', null)]),
    ]);
    expect(out).toContain('[工具 run: do_stuff → (无输出)]');
  });

  it('XML 最小转义：< > & 全转义', () => {
    const out = buildHistoryPromptBlock([
      turn('T1', '<script>&</script>', [text('<b>&</b>')]),
    ]);
    expect(out).toContain('&lt;script&gt;&amp;&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>&');
  });

  it('user 超 MAX_USER_CHARS → 截断加 …', () => {
    const longUser = 'u'.repeat(1000);
    const out = buildHistoryPromptBlock([turn('T1', longUser, [text('ok')])]);
    const m = out.match(/<user>([\s\S]*?)<\/user>/);
    expect(m).not.toBeNull();
    const userBody = m![1]!;
    expect(userBody.length).toBeLessThanOrEqual(MAX_USER_CHARS + 1);
    expect(userBody.endsWith('…')).toBe(true);
  });

  it('assistant 超 MAX_ASSISTANT_CHARS → 截断加 …', () => {
    const longAsst = 'a'.repeat(3000);
    const out = buildHistoryPromptBlock([turn('T1', 'q', [text(longAsst)])]);
    const m = out.match(/<assistant>([\s\S]*?)<\/assistant>/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body.length).toBeLessThanOrEqual(MAX_ASSISTANT_CHARS + 1);
    expect(body.endsWith('…')).toBe(true);
  });

  it('总字节超 30KB → 从最早砍，保留最新；总字节 ≤ 上限', () => {
    // 构造 20 条，每条 assistant 2KB → 总 ~40KB > 30KB
    const payload = 'x'.repeat(1800); // 2000 上限内，保证不被单条截断
    const turns: Turn[] = [];
    for (let i = 1; i <= 20; i++) {
      const ts = `2026-04-25T10:00:${String(i).padStart(2, '0')}.000Z`;
      turns.push(turn(`T${i}`, `user${i}`, [text(payload)], ts));
    }
    // DB 顺序 DESC
    const out = buildHistoryPromptBlock(desc(...turns));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    // 最新一条（T20）必须在
    expect(out).toContain('<user>user20</user>');
    // 最早一条（T1）必须被砍
    expect(out).not.toContain('<user>user1</user>');
  });

  it('单轮就超限 → 不爆栈、输出 ≤ 上限、至少保留部分内容', () => {
    const bigUser = 'U'.repeat(50 * 1024);
    const bigAsst = 'A'.repeat(50 * 1024);
    const out = buildHistoryPromptBlock([turn('T1', bigUser, [text(bigAsst)])]);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(out).toContain('<past_conversation>');
    expect(out).toContain('<turn>');
    // 至少有 user / assistant 标签
    expect(out).toContain('<user>');
    expect(out).toContain('<assistant>');
  });

  it('顺序：DB DESC 输入 → 输出内 <turn> ASC（最早在前）', () => {
    const t1 = turn('T1', 'first', [text('a1')], '2026-04-25T10:00:01.000Z');
    const t2 = turn('T2', 'second', [text('a2')], '2026-04-25T10:00:02.000Z');
    const t3 = turn('T3', 'third', [text('a3')], '2026-04-25T10:00:03.000Z');
    const out = buildHistoryPromptBlock(desc(t1, t2, t3));
    const i1 = out.indexOf('<user>first</user>');
    const i2 = out.indexOf('<user>second</user>');
    const i3 = out.indexOf('<user>third</user>');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it('指令行在块首，不在块尾', () => {
    const out = buildHistoryPromptBlock([turn('T1', 'q', [text('a')])]);
    const openIdx = out.indexOf('<past_conversation>');
    const instrIdx = out.indexOf('以下是你与用户在本次会话之前的历史对话片段');
    const firstTurnIdx = out.indexOf('<turn>');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(instrIdx).toBeGreaterThan(openIdx);
    expect(firstTurnIdx).toBeGreaterThan(instrIdx);
  });
});
