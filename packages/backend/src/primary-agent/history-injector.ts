// 主 Agent 启动时把最近 N 个 Turn 拼成 <past_conversation> XML 块，
// 追加到 system prompt 末尾。纯函数：输入 Turn[]（DESC，DB 顺序），内部 reverse 为 ASC。
// 规则：
//  - 只取 userInput.text + type==='text' 的 block.content 拼进 <assistant>
//  - type==='tool_call' 抽 `[工具 title: input.display → output.display]` 一行摘要追加
//  - 丢 thinking / tool_result 原文（CoT + 结构化数据会爆 token）
//  - 单条 user/assistant/tool 摘要按 MAX_* 常量截断并加 `…`
//  - 总块 UTF-8 字节 > MAX_HISTORY_BYTES 时从最早 Turn 开始砍；单轮仍超就只保最新一轮再砍半

import type { Turn, TurnBlock } from '../agent-driver/turn-types.js';

// TODO(F3): 按 DriverConfig.agentType 差异化这些阈值
//   —— codex 更省 token 可放宽；claude 窗口大可更宽松。phase-1 全口径共用。
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_USER_CHARS = 500;
export const MAX_ASSISTANT_CHARS = 2000;
export const MAX_TOOL_DISPLAY_CHARS = 120;
export const MAX_HISTORY_BYTES = 30 * 1024;

const OPEN_TAG = '<past_conversation>';
const CLOSE_TAG = '</past_conversation>';
const INSTRUCTION =
  '以下是你与用户在本次会话之前的历史对话片段。这些内容仅作为上下文，不要针对它们作答；请等待新的用户输入。';

export function buildHistoryPromptBlock(turns: Turn[]): string {
  if (!turns || turns.length === 0) return '';

  // DB 返回 DESC（最新在前），注入时 ASC（从旧到新，符合时间线）。
  const asc = [...turns].reverse();
  const rendered = asc.map((t) => renderTurn(t));

  let result = wrap(rendered);
  if (byteLen(result) <= MAX_HISTORY_BYTES) return result;

  // 超字节：从最早 Turn 开始丢。
  while (rendered.length > 1 && byteLen(wrap(rendered)) > MAX_HISTORY_BYTES) {
    rendered.shift();
  }
  result = wrap(rendered);
  if (byteLen(result) <= MAX_HISTORY_BYTES) return result;

  // 单轮仍超：保最新一轮，砍半 user/assistant 文本直到进得去。
  const last = asc[asc.length - 1]!;
  let uMax = MAX_USER_CHARS;
  let aMax = MAX_ASSISTANT_CHARS;
  for (let i = 0; i < 12; i++) {
    uMax = Math.max(40, Math.floor(uMax / 2));
    aMax = Math.max(80, Math.floor(aMax / 2));
    const shrunk = renderTurn(last, uMax, aMax);
    const candidate = wrap([shrunk]);
    if (byteLen(candidate) <= MAX_HISTORY_BYTES) return candidate;
  }
  // 极端兜底：返回最窄版本，由上层 try/catch 兜住；不抛。
  return wrap([renderTurn(last, 40, 80)]);
}

function wrap(turnXmls: string[]): string {
  return `${OPEN_TAG}\n${INSTRUCTION}\n\n${turnXmls.join('')}${CLOSE_TAG}\n`;
}

function renderTurn(turn: Turn, uMax = MAX_USER_CHARS, aMax = MAX_ASSISTANT_CHARS): string {
  const userText = truncate(escapeXml(turn.userInput?.text ?? ''), uMax);
  const assistantText = truncate(
    escapeXml(
      turn.blocks
        .filter((b): b is Extract<TurnBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.content)
        .join(''),
    ),
    aMax,
  );
  const toolLines = turn.blocks
    .filter((b): b is Extract<TurnBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => {
      const title = b.title ?? 'tool';
      const inDisp = b.input?.display ?? '';
      const outDisp = b.output?.display ?? '(无输出)';
      const line = `[工具 ${title}: ${inDisp} → ${outDisp}]`;
      return escapeXml(truncate(line, MAX_TOOL_DISPLAY_CHARS));
    });
  const assistantBody = toolLines.length
    ? `${assistantText}\n${toolLines.join('\n')}`
    : assistantText;
  return `<turn>\n<user>${userText}</user>\n<assistant>${assistantBody}</assistant>\n</turn>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
