// primary-agent 的 runtime 选择 + sandbox 降级。从 primary-agent.ts 抽出控制行数。
// 非注入路径：按 row.sandbox 挑 Host/Docker；sandbox=true 但 docker 不可用时走 spawn→降级→重试。
import { HostRuntime } from '../process-runtime/host-runtime.js';
import { DockerRuntime } from '../process-runtime/docker-runtime.js';
import type { ProcessRuntime, RuntimeHandle, LaunchSpec } from '../process-runtime/types.js';
import type { AgentAdapter } from '../agent-driver/adapters/adapter.js';
import { createAdapter } from '../agent-driver/driver.js';
import type { DriverConfig } from '../agent-driver/types.js';
import { buildDriverConfig, resolveRuntimeKindFromEnv } from './driver-config.js';
import type { PrimaryAgentRow } from './types.js';

export interface SpawnDriverInput {
  row: PrimaryAgentRow;
  historyPromptBlock: string;
  /** 外部注入的 runtime（测试 FakeRuntime）；传就用它，不按 row.sandbox 切 */
  injected: ProcessRuntime | null;
}

export interface SpawnDriverOutput {
  runtime: ProcessRuntime;
  runtimeKind: 'host' | 'docker';
  config: DriverConfig;
  adapter: AgentAdapter;
  spec: LaunchSpec;
  handle: RuntimeHandle;
  skipped: string[];
}

// runtime 选择优先级：
//   injected → 保持注入实例 + env 兜底 runtimeKind（知识 id:621）
//   未注入   → row.sandbox → docker / host；sandbox=true 但 docker CLI 不可用时降级 Host 重试。
export async function spawnForRow(input: SpawnDriverInput): Promise<SpawnDriverOutput> {
  const { row, historyPromptBlock, injected } = input;
  let runtimeKind: 'host' | 'docker' = injected
    ? resolveRuntimeKindFromEnv()
    : (row.sandbox ? 'docker' : 'host');
  let runtime: ProcessRuntime = injected ?? (runtimeKind === 'docker' ? new DockerRuntime() : new HostRuntime());

  const first = buildDriverConfig({ row, historyPromptBlock, runtimeKind });
  let { config } = first;
  let adapter = createAdapter(config);
  let spec = adapter.prepareLaunch(config);
  let handle: RuntimeHandle;
  try {
    handle = await runtime.spawn(spec);
  } catch (err) {
    if (injected || runtimeKind !== 'docker') throw err;
    process.stderr.write(
      `[primary-agent] DockerRuntime.spawn failed (${(err as Error).message}); falling back to HostRuntime\n`,
    );
    runtimeKind = 'host';
    runtime = new HostRuntime();
    const rebuild = buildDriverConfig({ row, historyPromptBlock, runtimeKind });
    config = rebuild.config;
    adapter = createAdapter(config);
    spec = adapter.prepareLaunch(config);
    handle = await runtime.spawn(spec);
  }
  return { runtime, runtimeKind, config, adapter, spec, handle, skipped: first.skipped };
}
