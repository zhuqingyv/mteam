// AgentDriver 公共类型。保持 bus 无关、业务无关，只描述"怎么跑一个 ACP agent"。
// DriverEvent 是驱动层内部统一事件模型，driver.ts 把它翻译成 bus.BusEvent 再 emit。

export type DriverStatus = 'IDLE' | 'STARTING' | 'READY' | 'WORKING' | 'STOPPED';

export type AgentType = 'claude' | 'codex' | 'qwen';

export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface DriverConfig {
  agentType: AgentType;
  systemPrompt: string;
  mcpServers: McpServerSpec[];
  cwd: string;
  env?: Record<string, string>;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

// 驱动层对外的"语义事件"。driver.ts 负责加 driverId + 时间戳 + 映射到 bus 事件。
export type DriverEvent =
  | { type: 'driver.thinking'; content: string }
  | { type: 'driver.text'; content: string }
  | { type: 'driver.tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'driver.tool_result'; toolCallId: string; output: unknown; ok: boolean }
  | { type: 'driver.turn_done'; stopReason: string };
