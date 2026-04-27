// process-manager 单例出口。
// W1-3: import 不触发副作用；watcher / manager 均由调用方按需实例化或使用。
export {
  ProcessManager,
  type ManagedProcess,
  type RegisterEntry,
  type ProcessStats,
  type ProcessExitListener,
  type KillFn,
  type SnapshotEntry,
  type SnapshotFile,
} from './manager.js';

export { bootstrapReap, type StartupReapDeps } from './startup-reap.js';

export {
  watchParentAlive,
  type ParentWatcher,
  type ParentWatcherOptions,
} from './parent-watcher.js';

export {
  watchStdinEnd,
  type StdinWatcher,
  type StdinWatcherOptions,
} from './stdin-watcher.js';

import { ProcessManager } from './manager.js';

export const processManager = new ProcessManager();
