// CodexAdapter —— 适配 @zed-industries/codex-acp。
// - prompt 注入：systemPrompt 写临时文件，起进程时加 -c model_instructions_file=<path>。
//   （experimental_instructions_file 已废弃，见 project 知识 id 294）
// - MCP 注入：session/new.mcpServers 走标准字段（driver.ts 统一处理）。
// - 输出：ACP SDK 共用 11 种 sessionUpdate；Codex 厂商差异集中在 tool_call.rawInput
//   (unified_exec：command/cwd/parsed_cmd/process_id/turn_id) 和 tool_call_update.rawOutput
//   (stdout/stderr/exit_code/duration/formatted_output)。turn 完成通过 PromptResponse.stopReason
//   由 driver.ts 判定，adapter 不处理 turn_done。
// 覆盖范围对照 docs/phase-ws/turn-aggregator-design.md §3.3 / §2.3。
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from './adapter.js';
import type { LaunchSpec } from '../../process-runtime/types.js';
import type { DriverConfig, DriverEvent } from '../types.js';
import {
  compactAcpContent,
  extractContentText,
  mapToolKind,
  mapToolStatus,
  normalizeCommands,
  normalizeConfigOptions,
  normalizeLocations,
  normalizePlanEntries,
  normalizeToolInput,
  normalizeToolOutput,
} from '../normalize.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object';
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export class CodexAdapter implements AgentAdapter {
  private promptFile: string | null = null;

  prepareLaunch(config: DriverConfig): LaunchSpec {
    const args = ['-y', '@zed-industries/codex-acp'];
    if (config.systemPrompt) {
      this.promptFile = join(tmpdir(), `mteam-codex-prompt-${randomUUID()}.md`);
      writeFileSync(this.promptFile, config.systemPrompt, 'utf-8');
      args.push('-c', `model_instructions_file=${this.promptFile}`);
    }
    return {
      runtime: 'host',
      command: 'npx',
      args,
      env: { ...(config.env ?? {}) },
      cwd: config.cwd,
    };
  }

  sessionParams(_config: DriverConfig): Record<string, unknown> {
    // Codex 静默忽略 _meta.systemPrompt，走文件就行。
    return {};
  }

  parseUpdate(update: unknown): DriverEvent | null {
    if (!isObj(update)) return null;
    const kind = asStr(update.sessionUpdate);
    if (!kind) return null;

    switch (kind) {
      case 'agent_thought_chunk':
        return {
          type: 'driver.thinking',
          ...(asStr(update.messageId) ? { messageId: asStr(update.messageId)! } : {}),
          content: extractContentText(update.content),
        };

      case 'agent_message_chunk':
        return {
          type: 'driver.text',
          ...(asStr(update.messageId) ? { messageId: asStr(update.messageId)! } : {}),
          content: extractContentText(update.content),
        };

      case 'tool_call': {
        const toolCallId = asStr(update.toolCallId);
        if (!toolCallId) return null;
        const title = asStr(update.title) ?? '';
        const locations = normalizeLocations(update.locations);
        const content = compactAcpContent(update.content);
        // Codex 实测初始 status 常见 'in_progress'；未给则 pending。
        const status = mapToolStatus(update.status);
        return {
          type: 'driver.tool_call',
          toolCallId,
          // 过渡期 name 字段保留（types.ts 标 @deprecated，T-4/T-5 迁完后架构师清理）。
          name: title || 'tool',
          title,
          ...(mapToolKind(update.kind) ? { kind: mapToolKind(update.kind)! } : {}),
          status,
          ...(locations ? { locations } : {}),
          input: normalizeToolInput('codex', title, update.rawInput),
          ...(content.length > 0 ? { content } : {}),
        };
      }

      case 'tool_call_update': {
        const toolCallId = asStr(update.toolCallId);
        if (!toolCallId) return null;
        const hasRawOutput = Object.prototype.hasOwnProperty.call(update, 'rawOutput');
        const hasContent = update.content !== undefined && update.content !== null;
        const locations = normalizeLocations(update.locations);
        return {
          type: 'driver.tool_update',
          toolCallId,
          ...(update.status !== undefined ? { status: mapToolStatus(update.status) } : {}),
          ...(asStr(update.title) !== undefined ? { title: asStr(update.title)! } : {}),
          ...(mapToolKind(update.kind) ? { kind: mapToolKind(update.kind)! } : {}),
          ...(locations ? { locations } : {}),
          ...(hasRawOutput ? { output: normalizeToolOutput('codex', update.rawOutput) } : {}),
          ...(hasContent ? { content: compactAcpContent(update.content) } : {}),
        };
      }

      case 'plan':
        return { type: 'driver.plan', entries: normalizePlanEntries(update.entries) };

      case 'available_commands_update':
        return {
          type: 'driver.commands',
          commands: normalizeCommands(update.availableCommands),
        };

      case 'current_mode_update': {
        const currentModeId = asStr(update.currentModeId);
        return currentModeId ? { type: 'driver.mode', currentModeId } : null;
      }

      case 'config_option_update':
        return {
          type: 'driver.config',
          options: normalizeConfigOptions(update.configOptions),
        };

      case 'session_info_update':
        return {
          type: 'driver.session_info',
          ...(asStr(update.title) !== undefined ? { title: asStr(update.title)! } : {}),
          ...(asStr(update.updatedAt) !== undefined ? { updatedAt: asStr(update.updatedAt)! } : {}),
        };

      case 'usage_update': {
        // UNSTABLE：Codex 每 turn 发一次 {used,size}；cost 字段两家都没实测到。
        if (typeof update.used !== 'number' || typeof update.size !== 'number') return null;
        const ev: DriverEvent = { type: 'driver.usage', used: update.used, size: update.size };
        if (isObj(update.cost)
          && typeof update.cost.amount === 'number'
          && typeof update.cost.currency === 'string') {
          ev.cost = { amount: update.cost.amount, currency: update.cost.currency };
        }
        return ev;
      }

      case 'user_message_chunk':
        // SDK 允许但 Codex 实测不发；留 null 让 driver 丢弃不产生空事件。
        return null;

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

  listTempFiles(): string[] {
    return this.promptFile ? [this.promptFile] : [];
  }
}
