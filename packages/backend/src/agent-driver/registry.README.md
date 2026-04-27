# agent-driver / registry

进程级 `driverId → AgentDriver` 映射单例。**非业务模块**：纯 Map 封装，不订阅事件、不依赖 bus / db / domain。

## 接口

```typescript
export class DriverRegistry {
  register(driverId: string, driver: AgentDriver): void;
  unregister(driverId: string): void;
  get(driverId: string): AgentDriver | undefined;
  list(): AgentDriver[];
  clear(): void;
}

export const driverRegistry: DriverRegistry;  // 进程级单例
```

权威合约见 `packages/backend/docs/phase-sandbox-acp/stage-3/TASK-LIST.md` §1.3。

## 使用示例

```typescript
import { driverRegistry } from './registry.js';
import { AgentDriver } from './driver.js';

// 业务侧（如 member-driver.subscriber）在 driver.start() 成功后注册：
const driver = new AgentDriver(instanceId, config, handle);
await driver.start();
driverRegistry.register(instanceId, driver);

// 下发消息时查表：
const d = driverRegistry.get(instanceId);
if (d?.isReady()) await d.prompt('hello');

// 停止 driver 时注销：
driverRegistry.unregister(instanceId);
await driver.stop();
```

## 注意事项

- **本模块不监听 bus 事件**。注册 / 注销由胶水层（`member-driver.subscriber`、`primary-agent` 等）在 `driver.start()` 成功后 / `driver.stop()` 前显式调用。registry 不关心 driver 是谁起的，也不关心它怎么死的。
- **单例是进程级的**。一个后端进程只有一个 `driverRegistry`；上层逻辑依赖它去做 `send_msg` 命中判断。业务模块之间共享同一张表，不要再起局部 registry。
- **重复 `register(id)` 覆盖旧引用**，不抛错。胶水层若遇到"同一 instanceId 再次 `instance.created`"，应先 `get` 出旧 driver 做 teardown，再 `register` 新的 —— 不是依赖覆盖语义偷懒。
- **`unregister` 幂等**。删不存在的 key 不抛错，多次调用效果一致。
- **`driverId` 与业务实体 id 等价**：成员 driver 的 driverId === `RoleInstance.id`；主 agent 的 driverId === `primaryAgentRow.id`。
- **测试不 mock**：Map 操作天然纯函数，单测里用普通对象当 driver 即可（`{ id } as unknown as AgentDriver`）。
