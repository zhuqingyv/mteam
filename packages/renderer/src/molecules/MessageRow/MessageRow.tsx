import Avatar from '../Avatar';
import MessageBubble from '../MessageBubble';
import MessageMeta from '../../atoms/MessageMeta';
import TypingDots from '../../atoms/TypingDots';
import TextBlock from '../../atoms/TextBlock';
import ToolCallList, { type ToolCall } from '../ToolCallList';
import type { TurnBlock } from '../../store/messageStore';
import './MessageRow.css';

interface MessageRowProps {
  role: 'agent' | 'user';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
  blocks?: TurnBlock[];
  streaming?: boolean;
}

function mapToolStatus(s?: string): 'running' | 'done' | 'error' {
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'failed' || s === 'error') return 'error';
  return 'running';
}

function formatDuration(startTs?: string, updatedTs?: string): string | undefined {
  if (!startTs || !updatedTs) return undefined;
  const start = new Date(startTs).getTime();
  const end = new Date(updatedTs).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function pickToolName(b: TurnBlock, fallback?: string): string {
  return b.title ?? b.toolName ?? fallback ?? 'tool';
}

function pickSummary(b: TurnBlock, fallback?: string): string | undefined {
  return b.output?.display ?? b.summary ?? fallback;
}

function renderBubbleBlock(block: TurnBlock, streaming: boolean) {
  switch (block.type) {
    case 'thinking':
      return <TypingDots key={block.blockId} />;
    case 'text':
      return (
        <TextBlock key={block.blockId} content={block.content ?? ''} streaming={streaming} />
      );
    default:
      return null;
  }
}

function blocksToToolCalls(blocks: TurnBlock[]): ToolCall[] {
  const map = new Map<string, ToolCall>();
  for (const b of blocks) {
    if (b.type !== 'tool_call' && b.type !== 'tool_result') continue;
    const id = b.blockId;
    const existing = map.get(id);
    const status = b.type === 'tool_result' && !b.status ? 'done' : mapToolStatus(b.status);
    map.set(id, {
      id,
      toolName: pickToolName(b, existing?.toolName),
      status,
      summary: pickSummary(b, existing?.summary),
      duration: formatDuration(b.startTs, b.updatedTs) ?? existing?.duration,
    });
  }
  return Array.from(map.values());
}

export default function MessageRow({
  role,
  content,
  time,
  read,
  agentName,
  thinking,
  toolCalls,
  blocks,
  streaming,
}: MessageRowProps) {
  const hasBlocks = blocks && blocks.length > 0;
  // text/thinking 都进气泡。text 一旦出现就不再渲染 thinking（兜底防止
  // store 残留或乱序到达的 thinking block 导致回复完还挂着 dots）。
  const bubbleBlocks = (() => {
    if (!hasBlocks) return [];
    const filtered = blocks.filter((b) => b.type === 'text' || b.type === 'thinking');
    const hasText = filtered.some((b) => b.type === 'text');
    return hasText ? filtered.filter((b) => b.type !== 'thinking') : filtered;
  })();
  const derivedToolCalls = hasBlocks ? blocksToToolCalls(blocks) : [];
  const mergedToolCalls = [...(toolCalls ?? []), ...derivedToolCalls];
  const lastTextIdx = (() => {
    for (let i = bubbleBlocks.length - 1; i >= 0; i--) {
      if (bubbleBlocks[i].type === 'text') return i;
    }
    return -1;
  })();
  const variant = thinking ? 'thinking' : role;
  return (
    <div className={`message-row message-row--${role}`}>
      {role === 'agent' && (
        <div className="message-row__avatar">
          <Avatar size={32} online />
        </div>
      )}
      <div className="message-row__body">
        {hasBlocks ? (
          bubbleBlocks.length > 0 && (
            <MessageBubble variant="agent" agentName={role === 'agent' ? agentName : undefined}>
              <div className="message-row__blocks">
                {bubbleBlocks.map((b, i) =>
                  renderBubbleBlock(b, !!streaming && i === lastTextIdx),
                )}
              </div>
            </MessageBubble>
          )
        ) : (
          <MessageBubble variant={variant} agentName={role === 'agent' ? agentName : undefined}>
            {content}
          </MessageBubble>
        )}
        {!thinking && !hasBlocks && (
          <div className="message-row__meta">
            <MessageMeta time={time} read={role === 'user' ? read : undefined} />
          </div>
        )}
        {role === 'agent' && mergedToolCalls.length > 0 && (
          <div className="message-row__tools">
            <ToolCallList calls={mergedToolCalls} />
          </div>
        )}
      </div>
    </div>
  );
}
