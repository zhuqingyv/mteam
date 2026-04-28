import type { McpToolVisibility } from '../domain/role-template.js';
import type { PermissionMode } from '../agent-driver/types.js';

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
  /** ACP 权限审批模式：auto=自动批准（秘书身份默认）；manual=透传前端用户决策。 */
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryAgentConfig {
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: McpToolVisibility[];
  sandbox?: boolean;
  permissionMode?: PermissionMode;
}
