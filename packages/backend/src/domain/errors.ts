// Domain 层公共 Error 类型。供 domain 内部抛、HTTP/MCP 层 catch 翻译。

// 超过 system.maxAgents 时由 RoleInstance.create 抛出。HTTP 层翻译成 409。
export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED';
  readonly resource = 'agent';
  readonly current: number;
  readonly limit: number;
  constructor(info: { current: number; limit: number }) {
    super(`agent quota exceeded: current=${info.current}, limit=${info.limit}`);
    this.name = 'QuotaExceededError';
    this.current = info.current;
    this.limit = info.limit;
  }
}
