export interface McpConfig {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: 'stdio' | 'sse';
  builtin: boolean;
}
