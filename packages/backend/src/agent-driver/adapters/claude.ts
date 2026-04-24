// ClaudeAdapter —— 适配 @agentclientprotocol/claude-agent-acp。
// - prompt 注入：_meta.systemPrompt = { append: <prompt> }（追加到 claude_code preset）。
// - MCP 注入：直接走 session/new.mcpServers 标准字段，driver.ts 统一处理。
// - 输出：agent_thought_chunk → thinking、agent_message_chunk → text、tool_call → tool_call。
import type { AgentAdapter } from './adapter.js';
import type { DriverConfig, SpawnSpec, DriverEvent } from '../types.js';

export class ClaudeAdapter implements AgentAdapter {
  prepareSpawn(config: DriverConfig): SpawnSpec {
    return {
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
      env: {
        ...(process.env as Record<string, string>),
        ...(config.env ?? {}),
      },
      cwd: config.cwd,
    };
  }

  sessionParams(config: DriverConfig): Record<string, unknown> {
    if (!config.systemPrompt) return {};
    return {
      _meta: { systemPrompt: { append: config.systemPrompt } },
    };
  }

  parseUpdate(update: unknown): DriverEvent | null {
    if (!update || typeof update !== 'object') return null;
    const u = update as { sessionUpdate?: string };
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk':
        return { type: 'driver.thinking', content: extractText(update) };
      case 'agent_message_chunk':
        return { type: 'driver.text', content: extractText(update) };
      case 'tool_call': {
        const t = update as {
          toolCallId: string;
          title?: string;
          rawInput?: unknown;
        };
        return {
          type: 'driver.tool_call',
          toolCallId: t.toolCallId,
          name: t.title ?? 'tool',
          input: t.rawInput ?? null,
        };
      }
      case 'tool_call_update': {
        const t = update as {
          toolCallId: string;
          status?: string;
          rawOutput?: unknown;
        };
        if (t.status !== 'completed' && t.status !== 'failed') return null;
        return {
          type: 'driver.tool_result',
          toolCallId: t.toolCallId,
          output: t.rawOutput ?? null,
          ok: t.status === 'completed',
        };
      }
      default:
        return null;
    }
  }

  cleanup(): void {
    // Claude 不落盘，无需清理。
  }
}

// ContentChunk.content 是 ACP ContentBlock，一般 { type: 'text', text: '...' }。
function extractText(update: unknown): string {
  const c = (update as { content?: { type?: string; text?: string } }).content;
  if (!c) return '';
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}
