// 主 Agent 启动前置：CLI 可用性探测、首次 auto-configure、老 DB 迁移、CLI 延迟等待。
// 从 primary-agent.ts 的 boot() 拆出来，隔离 cliManager 竞态处理逻辑。
import type { Subscription } from 'rxjs';
import type { EventBus } from '../bus/events.js';
import { cliManager } from '../cli-scanner/manager.js';
import { readRow, upsertConfig, setStatus } from './repo.js';
import {
  buildPrimaryPrompt,
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
      systemPrompt: buildPrimaryPrompt('MTEAM'),
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

// 等 cliManager 首次扫描完成后，验证 CLI 可用性再重入 boot()。
// 防死循环：ready() resolve 后若 CLI 仍不可用（扫描找不到或 readyPromise 被 teardown 清空），
// 做一次 refresh() 强制重扫；重扫后仍不可用则放弃，不再重入。
export function waitForCliScan(host: CliWaitHost): void {
  if (host.getCliSub()) return;
  const sub = host.eventBus.on('cli.available').subscribe((ev) => {
    process.stderr.write(`[primary-agent] cli '${ev.cliName}' available (waiting for full scan)\n`);
  });
  host.setCliSub(sub);

  const tryReboot = (): void => {
    if (!host.getCliSub()) return; // teardown 已清理，放弃重入
    const row = readRow();
    const neededCli = row?.cliType ?? ['claude', 'codex'].find((c) => cliManager.isAvailable(c));
    if (neededCli && cliManager.isAvailable(neededCli)) {
      host.getCliSub()!.unsubscribe();
      host.setCliSub(null);
      process.stderr.write(`[primary-agent] cli '${neededCli}' available, auto-start\n`);
      host.reboot();
    } else {
      // ready() 可能因 teardown 竞态导致空 resolve，做一次 refresh 补救
      void cliManager.refresh().then(() => {
        if (!host.getCliSub()) return;
        const cli2 = row?.cliType ?? ['claude', 'codex'].find((c) => cliManager.isAvailable(c));
        if (cli2 && cliManager.isAvailable(cli2)) {
          host.getCliSub()!.unsubscribe();
          host.setCliSub(null);
          process.stderr.write(`[primary-agent] cli '${cli2}' available after refresh, auto-start\n`);
          host.reboot();
        } else {
          host.getCliSub()!.unsubscribe();
          host.setCliSub(null);
          process.stderr.write('[primary-agent] CLI scan complete, no CLI found — staying stopped\n');
        }
      });
    }
  };

  void cliManager.ready().then(tryReboot);
}
