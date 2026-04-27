// AgentAdapter —— 屏蔽不同 ACP agent 的差异。
// 每个 adapter 把"怎么起进程 / 怎么传 prompt / 怎么解析 update"封装起来。
// driver.ts 只跟这个接口对话。
import type { LaunchSpec } from '../../process-runtime/types.js';
import type { DriverConfig, DriverEvent } from '../types.js';

export interface AgentAdapter {
  // 起进程前的准备：可能要写临时文件、拼 CLI 参数、设置 env。
  // 只产规格，不启动进程；启动交给 runtime.spawn(spec)。
  prepareLaunch(config: DriverConfig): LaunchSpec;

  // session/new 的 _meta 等额外参数。没有扩展需求就返回 {}。
  sessionParams(config: DriverConfig): Record<string, unknown>;

  // 解析 ACP session/update 通知 → 统一 DriverEvent。无法识别返回 null。
  // 传入 any 因 SDK 的 SessionUpdate 是 discriminated union，各 adapter 自行收窄。
  parseUpdate(update: unknown): DriverEvent | null;

  // 释放资源（删临时文件等）。driver.stop() 时调。
  cleanup(): void;

  // 返回 adapter 在 prepareLaunch 期间写入文件系统的临时文件路径。
  // 胶水层 spawn 成功后交给 processManager.attachTempFiles(pid, paths) 托管，
  // 进程 exit 时由 ProcessManager 统一 unlink（W2-8 / R2）。
  listTempFiles(): string[];
}
