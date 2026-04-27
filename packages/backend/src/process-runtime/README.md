# process-runtime

进程运行时抽象层。把 "怎么把 CLI 跑起来" 这件事从 driver / pty / member-agent 里抽出来，用统一的 `ProcessRuntime` + `RuntimeHandle` 接口对外暴露。

当前实现：`HostRuntime`（直接跑在宿主机，Stage 1 可用）、`DockerRuntime`（容器内跑，Stage 4 才填肉）。

## 契约

权威定义在 `types.ts`，跨 Stage 冻结，详见 `docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md`。对外导出：

- `LaunchSpec` / `StdioConfig` / `StdioMode` — 启动规约
- `RuntimeHandle` — 进程句柄（`stdin` / `stdout` / `pid` / `kill` / `onExit`）
- `ProcessRuntime` — 运行时接口（`spawn` / `isAvailable` / `destroy`）
- `isLaunchSpec` — 类型守卫

## HostRuntime

在宿主机上直接跑 CLI 的运行时实现。内部用 `child_process.spawn`，把 Node stream 通过 `Writable.toWeb` / `Readable.toWeb` 包成 Web Streams 暴露给调用方。

```typescript
import { HostRuntime } from './process-runtime';

const host = new HostRuntime();
const h = await host.spawn({
  runtime: 'host', command: 'node', args: ['-e', "process.stdout.write('hi')"],
  env: { PATH: process.env.PATH! }, cwd: process.cwd(),
});
h.onExit((code) => console.log('exit', code));
await h.kill();
```

**注意事项**

- `spec.runtime` 必须是 `'host'`，传 `'docker'` 抛 `HostRuntime cannot handle runtime=docker`。
- `stdio` 缺省 `{ stdin:'pipe', stdout:'pipe', stderr:'inherit' }`；只有 `'pipe'` 模式下 `handle.stdin` / `handle.stdout` 才承载真实字节流，其它模式下返回空 stream 兜底。
- `kill` 语义：SIGTERM → 2000ms 宽限 → SIGKILL。幂等 —— 多次调用只发一次信号序列，所有调用 resolve 在进程真正退出后。
- `onExit` 只允许注册一次；重复注册抛 `'onExit already registered'`。需要多消费者请自己 fan-out。
- `isAvailable(cli)` 扫 `process.env.PATH` 目录下是否存在可执行文件，不 spawn 子进程。
- `HostRuntime` 无状态，可 `new` 多个实例互不影响；`destroy()` 是 no-op，仅为契约对齐。

## DockerRuntime

容器化运行时实现（Stage 4 W1-C 落盘）。内部用 `docker run -i --rm` 起子进程，docker CLI 的 stdin/stdout 直通到调用方，kill 信号由 docker CLI 转发给容器 PID 1。

```typescript
import { DockerRuntime } from './process-runtime';

// 无参即走默认：image=mteam-agent:latest，network=mteam-bridge
const docker = new DockerRuntime();

const h = await docker.spawn({
  runtime: 'docker', command: 'claude-acp', args: [],
  env: { ROLE_INSTANCE_ID: 'inst-42' }, cwd: '/host/project',
});
h.onExit((code) => console.log('exit', code));
await h.kill();
```

**构造参数**（全可省）：

- `image` — 镜像名，缺省 `'mteam-agent:latest'`
- `network` — docker 网络，缺省 `'mteam-bridge'`（容器从此网络访问 `host.docker.internal`）
- `extraDockerArgs` — 追加在 image 前，供 Stage 5 volume/user 等 hook
- `dockerBin` — docker CLI 路径，缺省 `'docker'`

**默认 docker run 参数**（写死，不可通过 spec 覆盖）：

- `-i --rm` — 交互 stdin + 退出自动清理
- `--name mteam-<instanceIdSlug>-<hex6>` — 基于 `spec.env.ROLE_INSTANCE_ID` 生成，并发不冲突
- `--cap-drop ALL --security-opt no-new-privileges` — 最小权限
- `--network <cfg.network>` — 默认 `mteam-bridge`
- Linux 宿主上自动追加 `--add-host=host.docker.internal:host-gateway`（Mac/Windows Docker Desktop 自带解析）
- `-v <spec.cwd>:/workspace -w /workspace` — 把宿主 cwd 挂到容器 `/workspace`（只挂这一层，不 mount 整个文件系统）
- `-e KEY=VAL ...` — 逐个注入 `spec.env`
- `extraDockerArgs` 追加在 image 前，供 Stage 5 hook 卷挂载/user 等扩展

**注意事项**

- `spec.runtime` 必须是 `'docker'`，传 `'host'` 抛 `DockerRuntime cannot handle runtime=host`。
- `pid` 是 docker CLI **子进程**的 OS pid（number），不是容器 id。契约允许 `number | string`，本实现采用 number 方便 attach 调试工具。
- `kill` 语义：向 docker CLI 发 SIGTERM → docker 转发到容器 PID 1 → 2000ms 宽限 → SIGKILL 给 docker CLI。幂等。
- `onExit` 只能注册一次。exit code/signal 来自 docker CLI 子进程（docker CLI 会把容器 exit code 透传出来；镜像不存在/pull 失败则是 docker CLI 自己的非零码）。
- `isAvailable(cliType)` 只 `docker image inspect <image>` 判镜像存在；不进一步探测镜像内是否含该 CLI（嫌启动代价高，由调用方在 spawn 后通过 onExit 感知）。
- docker CLI 本身不可用（`ENOENT`）时 `spawn()` 抛 `DockerRuntime: 无法启动 docker CLI ...`，便于区分于镜像缺失。
- `stdio.stderr` 支持传 `pipe`/`inherit`/`ignore`；不提供 stderr stream 字段（契约约束）。
- `DockerRuntime` 无持久连接，`destroy()` 是 no-op。

**测试：** `__tests__/docker-runtime.test.ts`。"构造与参数" 一组不需 docker 就能跑；"真容器" 一组用 `describe.skip` 在无 docker 环境整体跳过，有 docker 则跑 `node:20-slim` 真实往返 + kill + 镜像不存在 + env 注入。

## 类型守卫 isLaunchSpec

`isLaunchSpec(x: unknown): x is LaunchSpec` 校验 `runtime` / `command` / `args` / `env` / `cwd` 5 个必填字段，外加 `stdio`（若存在）的枚举值。用在调用方送进来的 payload 不可信时做启动前校验，通过后 TypeScript 自动收窄到 `LaunchSpec`。

```typescript
import { isLaunchSpec } from './process-runtime';

function launch(input: unknown, runtime: ProcessRuntime) {
  if (!isLaunchSpec(input)) {
    throw new Error('invalid LaunchSpec');
  }
  return runtime.spawn(input); // input 已被收窄成 LaunchSpec
}
```

校验规则：

- `runtime === 'host' | 'docker'`
- `command` 非空字符串
- `args` 全为字符串的数组
- `env` 是普通 object（非数组非 null），所有 value 为字符串
- `cwd` 非空字符串
- `stdio` 要么缺省，要么每个子字段（若存在）∈ `{ pipe, inherit, ignore }`

守卫不做副作用、不 log。
