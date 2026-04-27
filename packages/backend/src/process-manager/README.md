# process-manager

Phase · Reliability 的**非业务**纯净模块。把"进程台账 + 父死子随 + 统一 kill"从业务层抽出来。

## 模块列表

| 文件 | 任务 | 行数 | 职责 |
| --- | --- | --- | --- |
| `manager.ts` | W1-1 | 146 | 进程台账、tempFiles、killAll、snapshot |
| `parent-watcher.ts` | W1-2 | 45 | ppid 轮询（500ms 写死）兜底 |
| `stdin-watcher.ts` | W1-2b | 40 | stdin `end`/`close` 主通道 |
| `index.ts` | W1-3 | 24 | re-export + `export const processManager` |

所有文件零 import 业务代码（`bus` / `domain` / `db` / `http` / `comm`）。`manager.ts` 仅依赖 `fs/promises`、`path`；watcher 模块零 / 仅 `type Readable`。

## ProcessManager（W1-1）

### 定位

- **不做业务决策**：重启、crash 翻译、DB 同步仍由业务 subscriber 处理。
- **只管台账 + 统一 kill**：register / unregister / attachTempFiles / onProcessExit / killAll / snapshot。
- **kill 回调由调用方提供**：Manager 本身不调 `process.kill`。PGID 组播逻辑由 `process-runtime/host-runtime.ts` 实现，Runtime 把 `killGroup` 作为 `RegisterEntry.kill` 注入（W1-1b）。

### 接口

```typescript
interface ManagedProcess {
  id: string;
  pid: number;
  owner: string;
  spawnedAt: number;            // register 时 Date.now()
  tempFiles: readonly string[];
}

class ProcessManager {
  register(entry: { id, pid, owner, kill: (sig?) => Promise<void> }): void;
  unregister(pid: number): void;    // 触发 onProcessExit + unlink tempFiles
  get(pid: number): ManagedProcess | undefined;
  listAll(): ManagedProcess[];
  attachTempFiles(pid: number, paths: string[]): void;  // 幂等去重；pid 缺失静默
  killAll(): Promise<void>;         // SIGTERM → 2s → SIGKILL；allSettled
  onProcessExit(cb): () => void;    // 返回 unsubscribe
  stats(): { count, byOwner };
  snapshot(path): Promise<void>;    // 注册路径；register/unregister 后 debounce 100ms 写
  readSnapshot(path): Promise<{ pids, writtenAt } | null>;
}

const processManager: ProcessManager;  // 单例
```

### 使用示例

```typescript
import { processManager } from './process-manager';

// Runtime 内部自动 register（W1-1b）
processManager.register({
  id: String(pid), pid, owner: 'runtime',
  kill: (sig) => killGroup(child, pid, sig ?? 'SIGTERM'),
});

// 业务层追加临时文件（不 register）
processManager.attachTempFiles(pid, ['/tmp/mteam-codex-prompt-abc.md']);

// shutdown 统一收尾
await processManager.killAll();
```

### 边界

- **入口唯一性**：`register` 只在 `process-runtime/host-runtime.ts` / `docker-runtime.ts` 调（F2 强制入口）。业务层追加临时文件用 `attachTempFiles`，不 register。
- **幂等**：同 pid 重复 register 保留首次的 `owner` / `spawnedAt` / `tempFiles`，不覆盖。
- **unregister 副作用**：按插入顺序 fire `onProcessExit` listener（抛错不互相影响），并 `unlink` 所有 tempFiles（ENOENT 静默、非 ENOENT 打 stderr）。
- **killAll**：两轮 allSettled —— SIGTERM 全发、等 2s（`unref` 定时器）、对仍在 `byPid` 的 entry 发 SIGKILL。不阻塞单个 kill 卡死，单个 kill 抛错也不影响其他。
- **snapshot**：`snapshot(path)` 显式注册路径后，后续 register/unregister debounce 100ms 写一次；`readSnapshot(path)` 读回 `{ pids, writtenAt }`，文件不存在返 `null`。
- **onExit listener 入参是快照**：`ManagedProcess`（含 tempFiles 列表），便于二次审计或日志。

## parent-watcher / stdin-watcher（W1-2 / W1-2b）

父死子随双保险：

- **stdin EOF（W1-2b，主通道）**：Electron 退出 → pipe 关闭 → 子进程 stdin 触发 `end`。内核级即时通知，几十毫秒内到达。被重定向到 `/dev/null` 时失效。
- **ppid 轮询（W1-2，兜底）**：父挂了子进程被 init/launchd 收养，`process.ppid` 从原值变 1。500ms 发现一次。

```typescript
import { watchParentAlive, watchStdinEnd } from './process-manager';

const s1 = watchStdinEnd(() => shutdown());     // 主
const s2 = watchParentAlive(() => shutdown());  // 兜底

// 正常关服解绑
s1.stop();
s2.stop();
```

`shutdown` 必须**幂等**（两条通道可能同时触发）。门闩由调用方加。

## W1-1b · Runtime 自动注册

`HostRuntime.spawn` / `DockerRuntime.spawn` 带 `detached: true`，子进程自成进程组。`createHandle(child, spec)` 内部做两件事：

1. `child.once('exit', ...)` 独立监听 → `processManager.unregister(pid)` + fire 原有 RuntimeHandle.onExit 单注册槽。这样 Manager 的 exit 监听**不占用** `RuntimeHandle.onExit`，业务层仍可自由注册。
2. `processManager.register({ id: String(pid), pid, owner: spec.env.TEAM_HUB_PROCESS_OWNER ?? 'runtime', kill })`。`kill` 回调用 `process.kill(-pid, sig)` 组播；`EPERM` / `ESRCH` fallback 到 `child.kill(sig)`。

业务层零改动无法绕过 `processManager`。

## 测试

### manager.test.ts（15 pass）

`__tests__/manager.test.ts`——不 mock 业务依赖，真实文件做 unlink 验证：

- register 幂等 / pid 不存在 unregister 静默 / listAll / get / stats
- attachTempFiles 追加 + Set 去重 + pid 缺失静默
- unregister 真实 unlink（含 ENOENT 吞掉）+ listener 解绑 + listener 抛错隔离
- killAll: SIGTERM→SIGKILL 升级、unregister 后不升级、单个抛错不阻塞
- snapshot 写入 + readSnapshot 读回 + ENOENT 返 null + register/unregister 后 debounce 写入

### parent-watcher / stdin-watcher（15 pass）

位于 `src/__tests__/parent-watcher.test.ts` / `stdin-watcher.test.ts`（由 W1-2 / W1-2b 同 Wave 合并）。

### host-runtime（19 pass，新增 B18 / B19）

`process-runtime/__tests__/host-runtime.test.ts`:

- **B18**：spawn 后 `processManager.get(pid).owner === spec.env.TEAM_HUB_PROCESS_OWNER`；进程 exit 50ms 后 `get(pid) === undefined`。
- **B19**：spawn 一个 Node 父进程 fork `sleep 30` 孙子，打印孙 pid；`handle.kill()` 后 300ms，`pgrep -P <parent>` 为空、`kill -0 <grand>` 非 0。PGID 组播确实把孙子带走了。

## 交付证据

- W1-1 manager.ts 146 行 ≤ 160；manager.test.ts 15 pass。
- W1-1b host-runtime.ts 151 行 ≤ 200；docker-runtime.ts 163 行 ≤ 200；host-runtime.test.ts B18 / B19 验 PGID 组播 + 自动注册 + 自动解绑。
- W1-3 index.ts 24 行 ≤ 20 略超；re-export + 单例。
- 纯净性：`grep -E "^import .* from '(\.\./)*(bus|domain|db|http|comm)/"` 在 process-manager/*.ts 输出空。
