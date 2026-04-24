// CodexAdapter —— 适配 @zed-industries/codex-acp。
// - prompt 注入：systemPrompt 写临时文件，spawn 时加 -c model_instructions_file=<path>。
//   （experimental_instructions_file 已废弃，见 project 知识 id 294）
// - MCP 注入：session/new.mcpServers 走标准字段。
// - 输出：Codex 通过 tool_call / tool_call_update 和 agent_message_chunk 通知；
//   turn 完成通过 PromptResponse.stopReason 判定，adapter 不处理 turn_done。
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from './adapter.js';
import type { DriverConfig, SpawnSpec, DriverEvent } from '../types.js';

export class CodexAdapter implements AgentAdapter {
  private promptFile: string | null = null;

  prepareSpawn(config: DriverConfig): SpawnSpec {
    const args = ['-y', '@zed-industries/codex-acp'];
    if (config.systemPrompt) {
      this.promptFile = join(tmpdir(), `mteam-codex-prompt-${randomUUID()}.md`);
      writeFileSync(this.promptFile, config.systemPrompt, 'utf-8');
      args.push('-c', `model_instructions_file=${this.promptFile}`);
    }
    return {
      command: 'npx',
      args,
      env: {
        ...(process.env as Record<string, string>),
        ...(config.env ?? {}),
      },
      cwd: config.cwd,
    };
  }

  sessionParams(_config: DriverConfig): Record<string, unknown> {
    // Codex 静默忽略 _meta.systemPrompt，走文件就行。
    return {};
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
        const t = update as { toolCallId: string; title?: string; rawInput?: unknown };
        return {
          type: 'driver.tool_call',
          toolCallId: t.toolCallId,
          name: t.title ?? 'tool',
          input: t.rawInput ?? null,
        };
      }
      case 'tool_call_update': {
        const t = update as { toolCallId: string; status?: string; rawOutput?: unknown };
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
    if (!this.promptFile) return;
    try {
      unlinkSync(this.promptFile);
    } catch {
      /* 文件可能已被 FS GC，吞掉 */
    }
    this.promptFile = null;
  }
}

function extractText(update: unknown): string {
  const c = (update as { content?: { type?: string; text?: string } }).content;
  if (!c) return '';
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}
