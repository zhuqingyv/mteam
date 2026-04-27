// W2-F: 消息通知行 — agent 只看这一行（含 msg_id），想看详情调 read_message。
// 契约：输出严格匹配 /^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$/

export interface FormatNotifyInput {
  envelopeId: string;
  fromDisplayName: string;
  summary: string;
}

export function formatNotifyLine(input: FormatNotifyInput): string {
  return `@${input.fromDisplayName}>${input.summary}  [msg_id=${input.envelopeId}]`;
}

/**
 * @deprecated 老格式 shim，内部 delegate 到 formatNotifyLine。下个 Phase 删。
 * 老调用方（若有）通过 summary 字段拿到新格式；content/action/kind 字段不再渲染。
 */
export interface FormatMemberMessageInput {
  from: string;
  kind?: 'system' | 'chat';
  summary: string;
  content?: string;
  action?: string;
}

function fromDisplay(from: string): string {
  const idx = from.indexOf(':');
  if (idx < 0) return from;
  const id = from.slice(idx + 1);
  return id.length > 0 ? id : from;
}

export function formatMemberMessage(payload: FormatMemberMessageInput): string {
  // shim：没有 envelopeId 就回落一个稳定占位，保证老测试不炸；新代码不应走这里。
  return formatNotifyLine({
    envelopeId: 'msg_legacy',
    fromDisplayName: fromDisplay(payload.from),
    summary: payload.summary ?? '',
  });
}
