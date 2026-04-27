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

export type ResolvedMcpSpec =
  | {
      kind: 'builtin';
      name: 'mteam' | 'mteam-primary' | 'searchTools';
      env: Record<string, string>;
      visibility: { surface: string[] | '*'; search: string[] | '*' };
    }
  | {
      kind: 'user-stdio';
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    };

export interface ResolvedMcpSet {
  specs: ResolvedMcpSpec[];
  skipped: string[];
}
