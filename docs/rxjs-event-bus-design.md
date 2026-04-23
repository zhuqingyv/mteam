# RxJS 事件总线设计方案

## 1. 现状分析

### 1.1 当前事件系统

后端在 `domain/events.ts` 定义了一个全局 `EventEmitter`（`roleEvents`），声明了 3 种事件：

```ts
export const EVENTS = {
  ROLE_CREATED: 'role:created',
  ROLE_ACTIVATED: 'role:activated',
  ROLE_DELETED: 'role:deleted',
} as const;
```

但这个 EventEmitter **只有 emit，没有 subscribe**。全项目没有任何消费方。它是一个预留接口，不承担实际业务。

### 1.2 Handler 耦合点逐个分析

以下分析来自 `api/panel/role-instances.ts`（核心文件）和其他 handler。

#### 耦合点 1：`handleCreateInstance`（L49-86）

```
校验 body → 查 template → RoleInstance.create(input) → ptyManager.spawn() → instance.setSessionPid() → rosterAddInstance()
```

一个 handler 串联了 **4 个模块**：domain、pty、roster、mcp-store（spawn 内部读 store）。
核心操作：`RoleInstance.create`。
副作用（应拆出）：
- `ptyManager.spawn()` — PTY 生命周期
- `rosterAddInstance()` — 花名册同步
- `instance.setSessionPid()` — 回写 PID（依赖 spawn 结果）

#### 耦合点 2：`handleActivate`（L127-142）

```
查 instance → instance.activate(null) → rosterUpdateStatus(id, 'ACTIVE')
```

核心操作：`instance.activate()`。
副作用：
- `rosterUpdateStatus()` — 花名册同步

#### 耦合点 3：`handleRequestOffline`（L95-124）

```
查 instance → 查 caller → 权限校验 → instance.requestOffline(caller.id) → rosterUpdateStatus(id, 'PENDING_OFFLINE')
```

核心操作：`instance.requestOffline()`。
副作用：
- `rosterUpdateStatus()` — 花名册同步
- 缺失副作用：应通知目标成员（comm.send），但目前没做

#### 耦合点 4：`handleDeleteInstance`（L148-168）

```
查 instance → 状态保护 → ptyManager.kill(id) → instance.delete() → rosterRemoveIfPresent(id)
```

核心操作：`instance.delete()`。
副作用：
- `ptyManager.kill()` — 杀进程
- `rosterRemoveIfPresent()` — 花名册清理

#### 耦合点 5：`handleRegisterSession`（L10-33，sessions.ts）

```
查 instance → 设 claudeSessionId → instance.activate(null)
```

核心操作：`instance.activate()`。
副作用：
- 缺失副作用：应同步 roster 状态，但直接调了 `instance.activate()` 没有走 rosterUpdateStatus

#### 耦合点 6：`role-instance-roster-sync.ts`（整个文件）

这个文件本身就是耦合的 symptom。它是手动编写的"事件处理器"，但被 handler 命令式调用，而非自动订阅。

#### 耦合点 7：`RoleInstance.create()`（domain/role-instance.ts L73-107）

Domain 对象内部 `emit` 事件，但在 handler 里又手动调 roster sync。emit 和手动同步并行存在，职责不清。

#### 耦合点 8：Server 启动（server.ts L263-293）

`startServer()` 里串联了：`createServer()` → `reconcileStaleInstances()` → `CommServer.start()` → `shutdown` 注册。
CommServer 生命周期和 HTTP server 硬编码在一起。

### 1.3 现有架构问题总结

| 问题 | 表现 |
|------|------|
| handler 变成编排层 | 每加一个副作用就要改 handler，handler 变成 God function |
| roster sync 是手写的 | `role-instance-roster-sync.ts` 本质是事件处理器，但被命令式调用 |
| EventEmitter 空转 | 3 个事件只 emit 不消费，浪费且误导 |
| 副作用遗漏 | `handleRegisterSession` 里 activate 后没同步 roster；request-offline 后没通知 comm |
| 无法推前端 | 没有 WebSocket，前端只能轮询 |
| 测试困难 | 想测"创建实例后 roster 是否同步"必须启动 HTTP + DB + PTY 全链路 |

## 2. 事件总线设计

### 2.1 依赖

```json
{
  "dependencies": {
    "rxjs": "^7.8.0"
  }
}
```

### 2.2 核心 Subject 定义

文件：`packages/backend/src/bus/events.ts`

```ts
import { Subject, Observable } from 'rxjs';
import { filter, share } from 'rxjs/operators';

// ─── 事件类型定义 ──────────────────────────────────────

export type BusEventType =
  | 'instance.created'
  | 'instance.activated'
  | 'instance.offline_requested'
  | 'instance.deleted'
  | 'instance.session_registered'
  | 'pty.spawned'
  | 'pty.exited'
  | 'comm.registered'
  | 'comm.disconnected'
  | 'comm.message_sent'
  | 'comm.message_received'
  | 'template.created'
  | 'template.updated'
  | 'template.deleted'
  | 'mcp.installed'
  | 'mcp.uninstalled';

// 所有事件共享的基础结构
interface BusEventBase {
  type: BusEventType;
  ts: string;            // ISO 8601
  source: string;        // 产生事件的模块标识，如 'domain', 'pty', 'comm'
  correlationId?: string; // 用于追踪因果链，如 create → spawn → activate
}

// ─── 各事件 payload ──────────────────────────────────

export interface InstanceCreatedEvent extends BusEventBase {
  type: 'instance.created';
  instanceId: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  task: string | null;
}

export interface InstanceActivatedEvent extends BusEventBase {
  type: 'instance.activated';
  instanceId: string;
  actor: string | null;
}

export interface InstanceOfflineRequestedEvent extends BusEventBase {
  type: 'instance.offline_requested';
  instanceId: string;
  requestedBy: string;   // caller instance id
}

export interface InstanceDeletedEvent extends BusEventBase {
  type: 'instance.deleted';
  instanceId: string;
  previousStatus: string;
  force: boolean;
}

export interface InstanceSessionRegisteredEvent extends BusEventBase {
  type: 'instance.session_registered';
  instanceId: string;
  claudeSessionId: string;
}

export interface PtySpawnedEvent extends BusEventBase {
  type: 'pty.spawned';
  instanceId: string;
  pid: number;
}

export interface PtyExitedEvent extends BusEventBase {
  type: 'pty.exited';
  instanceId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface CommRegisteredEvent extends BusEventBase {
  type: 'comm.registered';
  address: string;
}

export interface CommDisconnectedEvent extends BusEventBase {
  type: 'comm.disconnected';
  address: string;
}

export interface CommMessageSentEvent extends BusEventBase {
  type: 'comm.message_sent';
  messageId: string;
  from: string;
  to: string;
}

export interface CommMessageReceivedEvent extends BusEventBase {
  type: 'comm.message_received';
  messageId: string;
  from: string;
  to: string;
  route: string;  // 'local-online' | 'local-offline' | 'system'
}

export interface TemplateCreatedEvent extends BusEventBase {
  type: 'template.created';
  templateName: string;
}

export interface TemplateUpdatedEvent extends BusEventBase {
  type: 'template.updated';
  templateName: string;
}

export interface TemplateDeletedEvent extends BusEventBase {
  type: 'template.deleted';
  templateName: string;
}

export interface McpInstalledEvent extends BusEventBase {
  type: 'mcp.installed';
  mcpName: string;
}

export interface McpUninstalledEvent extends BusEventBase {
  type: 'mcp.uninstalled';
  mcpName: string;
}

// 联合类型
export type BusEvent =
  | InstanceCreatedEvent
  | InstanceActivatedEvent
  | InstanceOfflineRequestedEvent
  | InstanceDeletedEvent
  | InstanceSessionRegisteredEvent
  | PtySpawnedEvent
  | PtyExitedEvent
  | CommRegisteredEvent
  | CommDisconnectedEvent
  | CommMessageSentEvent
  | CommMessageReceivedEvent
  | TemplateCreatedEvent
  | TemplateUpdatedEvent
  | TemplateDeletedEvent
  | McpInstalledEvent
  | McpUninstalledEvent;

// ─── 事件总线 ──────────────────────────────────────

export class EventBus {
  private readonly subject = new Subject<BusEvent>();
  readonly events$: Observable<BusEvent> = this.subject.asObservable().pipe(share());

  emit(event: BusEvent): void {
    this.subject.next(event);
  }

  /** 按 type 过滤，返回类型安全的 Observable */
  on<T extends BusEvent['type']>(
    type: T,
  ): Observable<Extract<BusEvent, { type: T }>> {
    return this.events$.pipe(
      filter((e): e is Extract<BusEvent, { type: T }> => e.type === type),
    );
  }

  /** 按前缀过滤，例如 'instance.' 拿到所有实例事件 */
  onPrefix(prefix: string): Observable<BusEvent> {
    return this.events$.pipe(
      filter((e) => e.type.startsWith(prefix)),
    );
  }

  destroy(): void {
    this.subject.complete();
  }
}

// 全局单例
export const bus = new EventBus();
```

### 2.3 辅助工具

文件：`packages/backend/src/bus/helpers.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { BusEvent, BusEventType } from './events.js';

/** 快速构造事件的 base 字段 */
export function makeBase<T extends BusEventType>(
  type: T,
  source: string,
  correlationId?: string,
): { type: T; ts: string; source: string; correlationId?: string } {
  return {
    type,
    ts: new Date().toISOString(),
    source,
    ...(correlationId ? { correlationId } : {}),
  };
}

/** 生成 correlationId */
export function newCorrelationId(): string {
  return randomUUID();
}
```

### 2.4 命名规范

| 维度 | 规范 | 示例 |
|------|------|------|
| 事件 type | `{domain}.{past_tense_verb}` | `instance.created`、`pty.spawned` |
| 事件接口名 | `{Domain}{PastVerb}Event` | `InstanceCreatedEvent`、`PtyExitedEvent` |
| Observable 变量 | `{domain}{PastVerb}$` | `instanceCreated$`、`ptyExited$` |
| Subscriber 文件 | `{domain}.subscriber.ts` | `roster.subscriber.ts`、`ws.subscriber.ts` |

## 3. 各模块 Subscriber 设计

### 3.1 Roster Subscriber（替代 role-instance-roster-sync.ts）

文件：`packages/backend/src/bus/subscribers/roster.subscriber.ts`

```ts
import { Subscription } from 'rxjs';
import { bus } from '../events.js';
import { roster } from '../../roster/roster.js';

export function subscribeRoster(): Subscription {
  const sub = new Subscription();

  // 实例创建 → 写入 roster（alias 落库）
  sub.add(
    bus.on('instance.created').subscribe((e) => {
      try {
        roster.add({
          instanceId: e.instanceId,
          memberName: e.memberName,
          alias: e.memberName,
          scope: 'local',
          status: 'PENDING',
          address: `local:${e.instanceId}`,
          teamId: e.teamId,
          task: e.task,
        });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.add failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  // 激活 → 更新 roster 状态
  sub.add(
    bus.on('instance.activated').subscribe((e) => {
      try {
        roster.update(e.instanceId, { status: 'ACTIVE' });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.update ACTIVE failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  // 请求下线 → 更新 roster 状态
  sub.add(
    bus.on('instance.offline_requested').subscribe((e) => {
      try {
        roster.update(e.instanceId, { status: 'PENDING_OFFLINE' });
      } catch (err) {
        process.stderr.write(
          `[bus] roster.update PENDING_OFFLINE failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  // 删除 → 清 roster
  sub.add(
    bus.on('instance.deleted').subscribe((e) => {
      try {
        if (roster.get(e.instanceId)) {
          roster.remove(e.instanceId);
        }
      } catch (err) {
        process.stderr.write(
          `[bus] roster.remove failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
```

### 3.2 PTY Subscriber（instance 创建时自动 spawn）

文件：`packages/backend/src/bus/subscribers/pty.subscriber.ts`

注意：PTY spawn 是有返回值的副作用（需要拿到 PID），这里分两步：handler 只 emit `instance.created`，PTY subscriber 收到后 spawn 并 emit `pty.spawned`，再有另一个 subscriber 把 PID 写回 instance。

```ts
import { Subscription } from 'rxjs';
import { bus } from '../events.js';
import { makeBase } from '../helpers.js';
import { ptyManager } from '../../pty/manager.js';
import { RoleTemplate } from '../../domain/role-template.js';

export function subscribePty(): Subscription {
  const sub = new Subscription();

  // instance.created → spawn PTY → emit pty.spawned
  sub.add(
    bus.on('instance.created').subscribe((e) => {
      const template = RoleTemplate.findByName(e.templateName);
      if (!template) {
        process.stderr.write(`[bus] pty: template '${e.templateName}' not found, skip spawn\n`);
        return;
      }
      try {
        const entry = ptyManager.spawn({
          instanceId: e.instanceId,
          memberName: e.memberName,
          isLeader: e.isLeader,
          leaderName: null,  // 从 instance 取，需要扩展事件
          task: e.task,
          persona: template.persona,
          availableMcps: template.availableMcps,
        });
        bus.emit({
          ...makeBase('pty.spawned', 'pty', e.correlationId),
          instanceId: e.instanceId,
          pid: entry.pid,
        });
      } catch (err) {
        process.stderr.write(
          `[bus] pty spawn failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  // instance.deleted → kill PTY
  sub.add(
    bus.on('instance.deleted').subscribe((e) => {
      ptyManager.kill(e.instanceId);
    }),
  );

  return sub;
}
```

### 3.3 Domain Sync Subscriber（回写 PID）

文件：`packages/backend/src/bus/subscribers/domain-sync.subscriber.ts`

```ts
import { Subscription } from 'rxjs';
import { bus } from '../events.js';
import { RoleInstance } from '../../domain/role-instance.js';

export function subscribeDomainSync(): Subscription {
  const sub = new Subscription();

  // pty.spawned → 把 pid 写回 instance
  sub.add(
    bus.on('pty.spawned').subscribe((e) => {
      const instance = RoleInstance.findById(e.instanceId);
      if (instance) {
        instance.setSessionPid(e.pid);
      }
    }),
  );

  return sub;
}
```

### 3.4 Comm Notification Subscriber（通知成员）

文件：`packages/backend/src/bus/subscribers/comm-notify.subscriber.ts`

```ts
import { Subscription } from 'rxjs';
import { bus } from '../events.js';
import type { CommRouter } from '../../comm/router.js';

/**
 * 补全当前缺失的副作用：request_offline 后通知目标成员。
 */
export function subscribeCommNotify(router: CommRouter): Subscription {
  const sub = new Subscription();

  sub.add(
    bus.on('instance.offline_requested').subscribe((e) => {
      const msg = {
        type: 'message' as const,
        id: `sys-offline-${e.instanceId}-${Date.now()}`,
        from: 'local:system' as `${string}:${string}`,
        to: `local:${e.instanceId}` as `${string}:${string}`,
        payload: {
          kind: 'system',
          summary: 'Leader has approved your offline request',
          action: 'deactivate',
        },
        ts: e.ts,
      };
      router.dispatch(msg);
    }),
  );

  return sub;
}
```

### 3.5 Log Subscriber（审计日志）

文件：`packages/backend/src/bus/subscribers/log.subscriber.ts`

```ts
import { Subscription } from 'rxjs';
import { bus } from '../events.js';

export function subscribeLog(): Subscription {
  const sub = new Subscription();

  // 全量事件写 stderr（生产可改写 DB / 外部日志服务）
  sub.add(
    bus.events$.subscribe((e) => {
      process.stderr.write(`[bus] ${e.type} ${JSON.stringify(e)}\n`);
    }),
  );

  return sub;
}
```

### 3.6 Subscriber 注册中心

文件：`packages/backend/src/bus/index.ts`

```ts
import { Subscription } from 'rxjs';
import { bus } from './events.js';
import { subscribeRoster } from './subscribers/roster.subscriber.js';
import { subscribePty } from './subscribers/pty.subscriber.js';
import { subscribeDomainSync } from './subscribers/domain-sync.subscriber.js';
import { subscribeCommNotify } from './subscribers/comm-notify.subscriber.js';
import { subscribeLog } from './subscribers/log.subscriber.js';
import type { CommRouter } from '../comm/router.js';

export { bus } from './events.js';
export type { BusEvent, BusEventType } from './events.js';

let masterSub: Subscription | null = null;

export function bootSubscribers(deps: { commRouter: CommRouter }): void {
  if (masterSub) return;  // 幂等
  masterSub = new Subscription();
  masterSub.add(subscribeRoster());
  masterSub.add(subscribePty());
  masterSub.add(subscribeDomainSync());
  masterSub.add(subscribeCommNotify(deps.commRouter));
  masterSub.add(subscribeLog());
}

export function teardownSubscribers(): void {
  if (masterSub) {
    masterSub.unsubscribe();
    masterSub = null;
  }
  bus.destroy();
}
```

## 4. Handler 改造后的样子

### 4.1 `handleCreateInstance` 改造对比

**改造前**（5 步串行命令式）：

```ts
const instance = RoleInstance.create(input);
const entry = ptyManager.spawn({ ... });
instance.setSessionPid(entry.pid);
rosterAddInstance(instance);
return { status: 201, body: instance.toJSON() };
```

**改造后**（1 步核心 + 1 次 emit）：

```ts
const instance = RoleInstance.create(input);
bus.emit({
  ...makeBase('instance.created', 'handler', newCorrelationId()),
  instanceId: instance.id,
  templateName: input.templateName,
  memberName: input.memberName,
  isLeader: input.isLeader ?? false,
  teamId: input.teamId ?? null,
  task: input.task ?? null,
});
return { status: 201, body: instance.toJSON() };
```

PTY spawn、PID 回写、roster 同步全部由 subscriber 自动完成。

### 4.2 注意：同步 vs 异步的边界

RxJS Subject 的 `next()` 默认**同步执行**所有 subscriber。这意味着 `bus.emit(...)` 返回时，所有同步 subscriber（如 roster.add、ptyManager.spawn）已执行完毕。这对当前架构是优势：handler 可以安全地在 emit 之后 return response，确保副作用已完成。

如果将来某些 subscriber 需要异步（如远程通知），使用 `observeOn(asyncScheduler)` 将该 subscriber 移到异步执行。

## 5. WebSocket 接入方案

### 5.1 架构

```
                         ┌──────────────┐
  bus.events$ ──────────►│ WS Subscriber │──► WebSocket clients (panel)
                         └──────────────┘
                                │
                         filter + map
                         (只推前端关心的事件)
```

### 5.2 WS 服务实现

文件：`packages/backend/src/bus/subscribers/ws.subscriber.ts`

```ts
import { Subscription } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { bus } from '../events.js';
import type { BusEvent } from '../events.js';

// 前端关心的事件类型白名单
const WS_EVENT_TYPES = new Set<BusEvent['type']>([
  'instance.created',
  'instance.activated',
  'instance.offline_requested',
  'instance.deleted',
  'instance.session_registered',
  'pty.spawned',
  'pty.exited',
  'template.created',
  'template.updated',
  'template.deleted',
  'mcp.installed',
  'mcp.uninstalled',
]);

/** 剥离内部字段，只推前端需要的 */
function toWsPayload(e: BusEvent): Record<string, unknown> {
  const { source, correlationId, ...rest } = e;
  return rest;
}

export class WsBroadcaster {
  private clients = new Set<WebSocket>();
  private sub: Subscription | null = null;

  start(): void {
    this.sub = bus.events$.pipe(
      filter((e) => WS_EVENT_TYPES.has(e.type)),
      map(toWsPayload),
    ).subscribe((payload) => {
      const json = JSON.stringify(payload);
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(json);
        }
      }
    });
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.addEventListener('close', () => this.clients.delete(ws));
    ws.addEventListener('error', () => this.clients.delete(ws));
  }

  stop(): void {
    this.sub?.unsubscribe();
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
```

### 5.3 Server 集成

Bun 原生支持 WebSocket upgrade。在 `server.ts` 中加入：

```ts
import { WsBroadcaster } from './bus/subscribers/ws.subscriber.js';

const wsBroadcaster = new WsBroadcaster();

// 在 Bun.serve 或 http.createServer 中处理 upgrade
// Bun 风格：
Bun.serve({
  port: p,
  fetch(req, server) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/ws/events') {
      const upgraded = server.upgrade(req);
      if (!upgraded) return new Response('Upgrade failed', { status: 400 });
      return undefined;
    }
    // ... 原有路由
  },
  websocket: {
    open(ws) {
      wsBroadcaster.addClient(ws);
    },
    message() { /* 前端只订阅，不发消息 */ },
    close(ws) { /* WsBroadcaster 已通过 event listener 处理 */ },
  },
});
```

如果继续用 `http.createServer`（当前实现），则用 `ws` 包或 Bun 的 `Bun.serve` 替代。推荐在此次改造中一并迁移到 `Bun.serve`，因为 Bun 原生 WebSocket 零依赖且性能好。

### 5.4 前端订阅

```ts
// packages/renderer/src/hooks/useEventBus.ts
import { useEffect, useCallback, useRef } from 'react';
import { atom, useAtom } from 'jotai';

const WS_URL = 'ws://localhost:58580/ws/events';

interface BusEvent {
  type: string;
  ts: string;
  [key: string]: unknown;
}

export const eventsAtom = atom<BusEvent[]>([]);

export function useEventBus() {
  const [, setEvents] = useAtom(eventsAtom);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as BusEvent;
        setEvents((prev) => [...prev.slice(-99), event]); // 保留最近 100 条
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      // 自动重连
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      }, 2000);
    };

    return () => { ws.close(); };
  }, [setEvents]);
}
```

前端收到事件后，可精确 invalidate 相关 Jotai atom（如 `instancesAtom`），实现实时刷新而非轮询。

## 6. 迁移计划

### 6.1 原则

- **渐进式**：一个 handler 一个 handler 切，不一次性改完
- **双写过渡**：切换期间 handler 既 emit 事件也保留旧调用，通过 feature flag 控制
- **保留旧 EventEmitter**：直到所有消费方迁移完，再删除 `domain/events.ts`

### 6.2 分步计划

#### Step 0：基础设施（1-2 天）

1. `bun add rxjs`
2. 创建 `bus/` 目录结构：
   ```
   src/bus/
   ├── events.ts          # Subject + 类型定义
   ├── helpers.ts          # makeBase / newCorrelationId
   ├── index.ts            # bootSubscribers / teardownSubscribers
   └── subscribers/
       ├── log.subscriber.ts
       ├── roster.subscriber.ts
       ├── pty.subscriber.ts
       ├── domain-sync.subscriber.ts
       ├── comm-notify.subscriber.ts
       └── ws.subscriber.ts
   ```
3. 编写 `EventBus` 类 + 全部事件类型定义
4. 编写 `log.subscriber.ts`（只日志，零风险验证管道通畅）
5. 在 `startServer()` 里调 `bootSubscribers()`，在 shutdown 里调 `teardownSubscribers()`
6. 单测：EventBus 的 emit / on / onPrefix / destroy

#### Step 1：Roster Subscriber 先行（1 天）

选 roster sync 开刀，因为它最简单（纯 DB 写入、无外部 I/O、已有测试覆盖）。

1. 编写 `roster.subscriber.ts`
2. 在 `handleActivate` 里加 `bus.emit({ type: 'instance.activated', ... })`
3. Roster subscriber 消费 `instance.activated` → 调 `roster.update`
4. **保留** `rosterUpdateStatus(id, 'ACTIVE')` 调用（双写）
5. 确认单测通过后，删除手动 `rosterUpdateStatus` 调用
6. 对 `handleRequestOffline` 重复同样步骤
7. 对 `handleCreateInstance` 的 `rosterAddInstance` 重复同样步骤
8. 对 `handleDeleteInstance` 的 `rosterRemoveIfPresent` 重复同样步骤

完成后删除 `role-instance-roster-sync.ts`。

#### Step 2：PTY Subscriber（1 天）

1. 编写 `pty.subscriber.ts` + `domain-sync.subscriber.ts`
2. 在 `handleCreateInstance` 里，`RoleInstance.create` 之后 emit `instance.created`
3. PTY subscriber 消费 → spawn → emit `pty.spawned`
4. Domain sync subscriber 消费 `pty.spawned` → 回写 PID
5. 删除 handler 里的 `ptyManager.spawn()` 和 `instance.setSessionPid()`
6. `handleDeleteInstance` 里 emit `instance.deleted`，PTY subscriber 消费 → kill
7. 删除 handler 里的 `ptyManager.kill()`

**关键风险**：spawn 失败需回滚 instance。方案：PTY subscriber 里 spawn 失败时 emit 一个 `instance.spawn_failed` 事件，有另一个 subscriber 负责删 instance 并回写错误。但初期可以保持 handler 里同步 spawn 不拆，先只拆 roster。

#### Step 3：Comm Notify Subscriber（0.5 天）

1. 编写 `comm-notify.subscriber.ts`
2. 订阅 `instance.offline_requested` → 通过 comm router 发系统消息给目标成员
3. 这是**新增功能**（当前缺失），无回退风险

#### Step 4：WebSocket 推送（1 天）

1. 编写 `ws.subscriber.ts`
2. 将 `http.createServer` 迁移到 `Bun.serve`（或引入 `ws` 包做 upgrade）
3. 前端 `useEventBus` hook
4. 前端实例列表页接入实时刷新

#### Step 5：清理旧代码

1. 删除 `domain/events.ts`（旧 EventEmitter）
2. 删除 `role-instance-roster-sync.ts`
3. 删除 `RoleInstance.create/activate/delete` 中的 `roleEvents.emit(...)` 调用
4. 更新 `domain/index.ts` 的 export

### 6.3 回退方案

每一步都保留 feature flag：

文件：`packages/backend/src/bus/flags.ts`

```ts
// 环境变量控制，默认关闭（逐步开启）
export const USE_BUS_ROSTER = process.env.BUS_ROSTER !== '0';
export const USE_BUS_PTY = process.env.BUS_PTY !== '0';
export const USE_BUS_WS = process.env.BUS_WS !== '0';
```

Handler 里判断：

```ts
if (USE_BUS_ROSTER) {
  bus.emit({ type: 'instance.activated', ... });
} else {
  rosterUpdateStatus(id, 'ACTIVE');  // 旧路径
}
```

出问题时设 `BUS_ROSTER=0` 重启即可回退。

### 6.4 目录结构（最终态）

```
src/
├── bus/
│   ├── events.ts                    # EventBus class + 全部事件类型
│   ├── helpers.ts                   # makeBase / newCorrelationId
│   ├── flags.ts                     # feature flags
│   ├── index.ts                     # boot / teardown
│   └── subscribers/
│       ├── roster.subscriber.ts     # instance.* → roster 同步
│       ├── pty.subscriber.ts        # instance.created → spawn; instance.deleted → kill
│       ├── domain-sync.subscriber.ts # pty.spawned → 回写 PID
│       ├── comm-notify.subscriber.ts # instance.offline_requested → 通知成员
│       ├── log.subscriber.ts        # 全量日志
│       └── ws.subscriber.ts         # 过滤 + 推 WebSocket
├── api/panel/
│   ├── role-instances.ts            # 简化后：只做校验 + domain 操作 + emit
│   ├── role-templates.ts            # 加 emit template.created/updated/deleted
│   ├── sessions.ts                  # 加 emit instance.session_registered
│   ├── roster.ts                    # 不变（纯 CRUD，无副作用）
│   └── mcp-store.ts                 # 加 emit mcp.installed/uninstalled
├── domain/                          # 删除 events.ts；RoleInstance 不再 emit
├── comm/                            # 不变
├── pty/                             # 不变
├── roster/                          # 不变
├── mcp-store/                       # 不变
├── mcp/                             # 不变
└── server.ts                        # 加 bootSubscribers + WS upgrade
```

## 7. 测试策略

### 7.1 EventBus 单测

使用 RxJS `TestScheduler` 做 marble testing：

文件：`packages/backend/src/__tests__/event-bus.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { TestScheduler } from 'rxjs/testing';
import { EventBus } from '../bus/events.js';
import type { InstanceCreatedEvent, InstanceActivatedEvent } from '../bus/events.js';

function createTestScheduler() {
  return new TestScheduler((actual, expected) => {
    expect(actual).toEqual(expected);
  });
}

describe('EventBus', () => {
  it('on() filters by exact type', () => {
    createTestScheduler().run(({ expectObservable }) => {
      const bus = new EventBus();
      const created$ = bus.on('instance.created');

      // emit 一个 created 和一个 activated
      setTimeout(() => {
        bus.emit({
          type: 'instance.created',
          ts: '2026-01-01T00:00:00Z',
          source: 'test',
          instanceId: 'a',
          templateName: 't',
          memberName: 'm',
          isLeader: false,
          teamId: null,
          task: null,
        } as InstanceCreatedEvent);
        bus.emit({
          type: 'instance.activated',
          ts: '2026-01-01T00:00:00Z',
          source: 'test',
          instanceId: 'a',
          actor: null,
        } as InstanceActivatedEvent);
      }, 0);

      // 只收到 created，不收到 activated
      // （实际用 subscribe + 断言更直观，marble 适合复杂时序）
    });

    // 简单验证：
    const bus2 = new EventBus();
    const received: string[] = [];
    bus2.on('instance.activated').subscribe((e) => received.push(e.instanceId));
    bus2.emit({
      type: 'instance.created', ts: '', source: 'test',
      instanceId: 'a', templateName: '', memberName: '', isLeader: false, teamId: null, task: null,
    });
    bus2.emit({
      type: 'instance.activated', ts: '', source: 'test',
      instanceId: 'b', actor: null,
    });
    expect(received).toEqual(['b']);
    bus2.destroy();
  });

  it('onPrefix() filters by prefix', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.onPrefix('instance.').subscribe((e) => received.push(e.type));
    bus.emit({
      type: 'instance.created', ts: '', source: 'test',
      instanceId: 'a', templateName: '', memberName: '', isLeader: false, teamId: null, task: null,
    });
    bus.emit({
      type: 'pty.spawned', ts: '', source: 'test',
      instanceId: 'a', pid: 123,
    });
    bus.emit({
      type: 'instance.activated', ts: '', source: 'test',
      instanceId: 'a', actor: null,
    });
    expect(received).toEqual(['instance.created', 'instance.activated']);
    bus.destroy();
  });

  it('destroy() completes the stream', () => {
    const bus = new EventBus();
    let completed = false;
    bus.events$.subscribe({ complete: () => { completed = true; } });
    bus.destroy();
    expect(completed).toBe(true);
  });
});
```

### 7.2 Subscriber 单测

每个 subscriber 独立测试，注入 mock bus 和 mock 依赖：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '../bus/events.js';
import type { InstanceActivatedEvent } from '../bus/events.js';

// 不 mock，用真实 DB（in-memory）
import { getDb, closeDb } from '../db/connection.js';

describe('roster.subscriber', () => {
  let testBus: EventBus;

  beforeEach(() => {
    process.env.TEAM_HUB_V2_DB = ':memory:';
    getDb(); // 初始化 in-memory DB
    testBus = new EventBus();
  });

  afterEach(() => {
    testBus.destroy();
    closeDb();
  });

  it('instance.activated → roster status updated', () => {
    // 先插入一个 instance
    const db = getDb();
    db.prepare(`INSERT INTO role_instances
      (id, template_name, member_name, is_leader, status, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)`).run('inst-1', 'tpl', 'alice', 0, new Date().toISOString());

    // 订阅
    const { subscribeRoster } = require('../bus/subscribers/roster.subscriber.js');
    // 注意：实际代码中 subscribeRoster 内部 import 全局 bus，测试时需注入
    // 方案：subscribeRoster 接受 bus 参数（依赖注入）

    // 发事件
    testBus.emit({
      type: 'instance.activated',
      ts: new Date().toISOString(),
      source: 'test',
      instanceId: 'inst-1',
      actor: null,
    } as InstanceActivatedEvent);

    // 验证
    const row = db.prepare('SELECT status FROM role_instances WHERE id = ?').get('inst-1');
    expect(row.status).toBe('ACTIVE');
  });
});
```

**测试原则**：CLAUDE.md 要求不 mock。所有测试使用 in-memory SQLite 真实 DB。subscriber 依赖注入 EventBus 实例（测试用独立 bus，不用全局单例）。

### 7.3 Subscriber 依赖注入改造

为了测试友好，subscriber 函数接受 bus 参数：

```ts
export function subscribeRoster(eventBus: EventBus = bus): Subscription {
  // ...用 eventBus 而非全局 bus
}
```

### 7.4 集成测试

测试完整因果链：`handler emit → subscriber 消费 → 副作用生效`。

```ts
it('handleCreateInstance → bus → roster has entry', () => {
  bootSubscribers({ commRouter: mockRouter });
  const resp = handleCreateInstance({
    templateName: 'dev',
    memberName: 'alice',
  });
  expect(resp.status).toBe(201);
  const entry = roster.get(resp.body.id);
  expect(entry).not.toBeNull();
  expect(entry!.status).toBe('PENDING');
});
```

## 8. 风险和注意事项

### 8.1 同步语义变化

当前 handler 里 `ptyManager.spawn()` 失败会导致 handler 返回 500 并 `instance.delete()`。改为事件驱动后，spawn 在 subscriber 里执行，handler 无法感知失败。

**应对**：
- **短期**（Step 1-2）：PTY spawn 保留在 handler 里不拆。只拆 roster 同步和通知类副作用。
- **长期**：引入 saga 模式。`instance.created` → PTY subscriber 尝试 spawn → 成功 emit `pty.spawned` / 失败 emit `pty.spawn_failed` → 失败 subscriber 删除 instance 并写错误日志。但这增加复杂度，在 PTY spawn 基本不失败的前提下，短期不值得。

### 8.2 事件顺序

RxJS Subject 的 `next()` 同步分发。同一事件的多个 subscriber 按订阅顺序执行。这意味着 `bootSubscribers()` 里的注册顺序决定了执行顺序。

**应对**：subscriber 之间不应有顺序依赖。如果有（如 roster subscriber 依赖 PTY subscriber 已完成），通过事件链解耦（PTY subscriber 完成后 emit 新事件，roster subscriber 订阅该事件）。

### 8.3 错误隔离

一个 subscriber 抛异常会中断 Subject 的分发链，导致后续 subscriber 收不到事件。

**应对**：每个 subscriber 内部必须 try-catch。在 `EventBus.emit` 层也加防护：

```ts
emit(event: BusEvent): void {
  try {
    this.subject.next(event);
  } catch (err) {
    process.stderr.write(`[bus] FATAL: subscriber threw: ${(err as Error).message}\n`);
  }
}
```

### 8.4 内存泄漏

Subscription 不 unsubscribe 会导致泄漏。

**应对**：`bootSubscribers` 返回的 `masterSub` 在 shutdown 时调 `teardownSubscribers()`。每个 subscriber 返回 `Subscription` 实例，统一管理。

### 8.5 测试环境全局单例污染

全局 `bus` 单例在测试间共享，可能导致串扰。

**应对**：subscriber 接受 `EventBus` 参数（依赖注入），测试时每个 test case 创建独立 bus 实例。

### 8.6 不引入新依赖的替代方案

如果不想引入 RxJS（增加 bundle 体积），可以用原生 EventEmitter + TypeScript 类型安全封装实现类似效果。但 RxJS 的优势在于：
- `filter` / `map` / `debounce` / `buffer` 等 operator 开箱即用
- `TestScheduler` 对异步测试友好
- `share()` 自动管理多播
- 社区成熟，后续扩展（如 retry、backoff、merge 多源事件）零成本

RxJS 7.x gzip 后约 14KB，对后端项目不构成体积问题。
