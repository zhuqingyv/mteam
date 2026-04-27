# adapters/ — ACP agent 适配层

## 一句话

把"怎么起一个 ACP agent、怎么解析它的 update"封装成 `AgentAdapter` 接口，
让 `driver.ts` 对具体 CLI（Claude / Codex / …）无感。

## 接口定义

```typescript
import type { LaunchSpec } from '../../process-runtime/types.js';
import type { DriverConfig, DriverEvent } from '../types.js';

export interface AgentAdapter {
  // 起进程前的准备：拼命令、写临时文件、设置 env。
  // 只产规格，不启动进程 —— 启动交给 runtime.spawn(spec)。
  prepareLaunch(config: DriverConfig): LaunchSpec;

  // session/new 的 _meta 等扩展参数。没有返回 {}。
  sessionParams(config: DriverConfig): Record<string, unknown>;

  // 解析 ACP session/update 通知 → 统一 DriverEvent。识别不了返回 null。
  parseUpdate(update: unknown): DriverEvent | null;

  // 释放资源（删临时文件等）。driver.stop() 时调。
  cleanup(): void;
}
```

## 新增 adapter 的 5 个步骤

```typescript
// 1. 新建 adapters/myagent.ts 实现 4 个方法
import type { AgentAdapter } from './adapter.js';
import type { LaunchSpec } from '../../process-runtime/types.js';
import type { DriverConfig, DriverEvent } from '../types.js';

export class MyAgentAdapter implements AgentAdapter {
  prepareLaunch(config: DriverConfig): LaunchSpec {
    return {
      runtime: 'host',                 // Stage 1 暂只支持 'host'
      command: 'npx',
      args: ['-y', '@scope/my-acp'],
      env: { ...(config.env ?? {}) },  // 不 spread process.env —— 由 glue 层合并
      cwd: config.cwd,
    };
  }
  sessionParams(_c: DriverConfig) { return {}; }
  parseUpdate(_u: unknown): DriverEvent | null { return null; }
  cleanup(): void { /* 无资源就留空 */ }
}

// 2. 在 driver.ts 的 createAdapter 分发里注册 agentType → new MyAgentAdapter()
```

## 为什么 prepareLaunch 不返回 RuntimeHandle？

职责切分：adapter 只声明"怎么起"，不负责"起"。
- adapter 产 `LaunchSpec`（纯数据，可 JSON 序列化）。
- runtime 拿 `LaunchSpec` 调 `runtime.spawn(spec)` 产 `RuntimeHandle`。
- 这样 Docker runtime 扩展时 adapter 零改动，换运行环境只换 runtime 实现。

## env 合并约定（重要）

`prepareLaunch` 返回的 `env` **只含** `config.env` 的 key。
父进程 `process.env`（PATH / HOME / ...）的合并由调用方（glue 层，
如 `primary-agent.ts`）负责 —— adapter 是非业务模块，不替调用方
做"是否继承父 env"的业务决策（host 要合、docker 不合）。

## 类型守卫

测试 / 运行时校验 `prepareLaunch` 返回值用：

```typescript
import { isLaunchSpec } from '../../process-runtime/types.js';
expect(isLaunchSpec(spec)).toBe(true);
```
