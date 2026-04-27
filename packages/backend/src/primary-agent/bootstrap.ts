// 主 Agent 启动前置：CLI 可用性探测、首次 auto-configure、老 DB 迁移、CLI 延迟等待。
// 从 primary-agent.ts 的 boot() 拆出来，隔离 cliManager 竞态处理逻辑。
import type { Subscription } from 'rxjs';
import type { EventBus } from '../bus/events.js';
import { cliManager } from '../cli-scanner/manager.js';
import { readRow, upsertConfig, setStatus } from './repo.js';
import {
  DEFAULT_PRIMARY_PROMPT,
  DEFAULT_PRIMARY_MCP_CONFIG,
  maybeMigrateDefaults,
} from './defaults.js';
import type { PrimaryAgentRow } from './types.js';

export type PrepareStartResult =
  | { kind: 'ready'; row: PrimaryAgentRow }
  | { kind: 'wait-cli' };

// 返回 ready 时调用方可以继续 start；返回 wait-cli 时必须调用 waitForCliScan。
// 幂等：driver 已存在时调用方自行短路。
export function prepareStart(): PrepareStartResult {
  let row = readRow();
  if (!row) {
    const cliType = ['claude', 'codex'].find((c) => cliManager.isAvailable(c));
    if (!cliType) {
      process.stderr.write('[primary-agent] boot: no CLI available, waiting for CLI scan...\n');
      return { kind: 'wait-cli' };
    }
    row = upsertConfig({
      name: 'MTEAM',
      cliType: cliType as 'claude' | 'codex',
      systemPrompt: DEFAULT_PRIMARY_PROMPT,
      mcpConfig: DEFAULT_PRIMARY_MCP_CONFIG,
    });
    process.stderr.write(`[primary-agent] boot: auto-configured with ${cliType}\n`);
  } else {
    const migrated = maybeMigrateDefaults(row);
    if (migrated) {
      row = migrated;
      process.stderr.write('[primary-agent] boot: migrated default prompt + mcpConfig\n');
    }
  }
  if (row.status === 'RUNNING') setStatus(row.id, 'STOPPED');
  if (!cliManager.isAvailable(row.cliType)) {
    process.stderr.write(
      `[primary-agent] boot: cli '${row.cliType}' unavailable, waiting for CLI scan...\n`,
    );
    return { kind: 'wait-cli' };
  }
  return { kind: 'ready', row };
}

export interface CliWaitHost {
  readonly eventBus: EventBus;
  getCliSub(): Subscription | null;
  setCliSub(sub: Subscription | null): void;
  reboot(): void;
}

// 等 cliManager.ready() 一次性完成全量扫描后再重入 boot()。
// 旧方案监听每条 cli.available 事件并重入 boot()，但 claude/codex 并行扫描时
// codex 先完成 → boot 重入 → claude 未完成 → 又订阅 → 无限循环。
// 改为 ready() 等全部扫完，只重入一次，彻底消除竞态。
export function waitForCliScan(host: CliWaitHost): void {
  if (host.getCliSub()) return;
  const sub = host.eventBus.on('cli.available').subscribe((ev) => {
    // 仅打日志，不重入 boot — 重入由 ready() 触发
    process.stderr.write(`[primary-agent] cli '${ev.cliName}' available (waiting for full scan)\n`);
  });
  host.setCliSub(sub);
  void cliManager.ready().then(() => {
    if (!host.getCliSub()) return; // teardown 已清理，放弃重入
    host.getCliSub()!.unsubscribe();
    host.setCliSub(null);
    const row = readRow();
    const neededCli = row ? row.cliType : ['claude', 'codex'].find((c) => cliManager.isAvailable(c));
    if (neededCli) {
      process.stderr.write(`[primary-agent] cli '${neededCli}' available, auto-start\n`);
    }
    host.reboot();
  });
}
