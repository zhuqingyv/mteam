import type { McpToolVisibility } from '../domain/role-template.js';

export type AgentState = 'idle' | 'thinking' | 'responding';

export interface PrimaryAgentRow {
  id: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  mcpConfig: McpToolVisibility[];
  status: 'STOPPED' | 'RUNNING';
  agentState?: AgentState;
  /** true = 走 DockerRuntime；false = HostRuntime。主 Agent 默认 true。 */
  sandbox: boolean;
  /** true = ACP requestPermission 自动选 allow；false = 一律 cancelled。主 Agent 默认 true。 */
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryAgentConfig {
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: McpToolVisibility[];
  sandbox?: boolean;
  autoApprove?: boolean;
}
