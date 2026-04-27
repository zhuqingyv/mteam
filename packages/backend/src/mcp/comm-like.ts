// 通信层最小契约：任何能给 mteam MCP 工具层投递消息的后端都实现这个接口。
// 具体实现：
//   - CommClient（stdio 子进程 → unix socket → CommServer）
//   - InProcessComm（mcp-http listener 内进程直连 commRouter）
//
// 工具层只依赖 CommLike，不关心传输细节。
export interface CommLike {
  ensureReady(): Promise<void>;
  send(opts: { to: string; payload: Record<string, unknown> }): Promise<void>;
  close(): void;
}
