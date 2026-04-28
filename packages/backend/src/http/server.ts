import http from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb, closeDb } from '../db/connection.js';
import { CommServer } from '../comm/index.js';
import { createDriverDispatcher } from '../comm/driver-dispatcher.js';
import { driverRegistry } from '../agent-driver/registry.js';
import { ensureDefaults as ensureMcpDefaults } from '../mcp-store/store.js';
import { ensureDefaultTemplates } from '../domain/default-templates.js';
import { ensureBuiltinAvatars } from '../avatar/init.js';
import { settingsRegistry } from '../settings/registry.js';
import { ALL_SETTING_ENTRIES } from '../settings/entries/index.js';
import { mcpManager } from '../mcp-store/mcp-manager.js';
import { cliManager } from '../cli-scanner/manager.js';
import { primaryAgent } from '../primary-agent/primary-agent.js';
import { bootSubscribers, teardownSubscribers, getTurnAggregator } from '../bus/index.js';
import { listRecentByDriver } from '../turn-history/repo.js';
import { attachWsUpgrade } from '../bus/ws-upgrade.js';
import { bus as defaultBus } from '../bus/events.js';
import { SubscriptionManager } from '../ws/subscription-manager.js';
import { WsBroadcaster } from '../ws/ws-broadcaster.js';
import { UserSessionTracker } from '../ws/user-session.js';
import { createVisibilityFilter } from '../filter/visibility-filter.js';
import { createFilterStore } from '../filter/filter-store.js';
import { createNotificationStore } from '../notification/notification-store.js';
import { createProxyRouter } from '../notification/proxy-router.js';
import { createMessageStore } from '../comm/message-store.js';
import { lookupAgentByInstanceId } from '../comm/agent-lookup.js';
import { BodyTooLargeError, CORS_HEADERS, jsonResponse } from './http-utils.js';
import { route } from './router.js';
import { servePanelHtml } from './panel-html.js';
import { reconcileStaleInstances } from './reconcile.js';
import { startMcpHttpServer, type McpHttpHandle } from '../mcp-http/index.js';
import { setMessagesContext } from './messages-context.js';
import { installFatalHandlers } from './fatal-handlers.js';
import { checkPidFile, attachPortGuard, writePidFile, removePidFile } from './singleton-guard.js';
import {
  watchStdinEnd,
  watchParentAlive,
  bootstrapReap,
  processManager,
} from '../process-manager/index.js';
import { makeBase } from '../bus/helpers.js';
import { globalTicker } from '../ticker/ticker.js';
import type { ActionItemScheduler } from '../action-item/scheduler.js';
import { createActionItemScheduler } from './action-item-wiring.js';

const PID_SNAPSHOT_PATH =
  process.env.TEAM_HUB_PID_SNAPSHOT ||
  join(homedir(), '.claude', 'team-hub', 'pid.snapshot');

const DEFAULT_PORT = 58590;

export function createServer(): http.Server {
  getDb();
  ensureMcpDefaults();
  ensureDefaultTemplates();
  ensureBuiltinAvatars();
  settingsRegistry.registerAll(ALL_SETTING_ENTRIES);
  return http.createServer(async (req, res) => {
    try {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/panel')) {
        servePanelHtml(res);
        return;
      }
      jsonResponse(res, await route(req));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        jsonResponse(res, { status: 413, body: { error: err.message } });
        return;
      }
      const msg = err instanceof Error ? err.message : 'internal server error';
      process.stderr.write(`[v2] error: ${msg}\n`);
      jsonResponse(res, { status: 500, body: { error: 'internal server error' } });
    }
  });
}

export function startServer(port?: number): http.Server {
  let shuttingDown = false;
  let shutdown = (): void => {};
  const trigger = (): void => { if (shuttingDown) return; shuttingDown = true; shutdown(); };
  const p = port ?? (Number(process.env.V2_PORT) || DEFAULT_PORT);
  // 单实例守卫：pid 文件存活 → 立刻 exit(1)。stale 自动清理。端口检测由 server.listen error 事件接管。
  checkPidFile(p);
  installFatalHandlers({ getBus: () => defaultBus, shutdown: trigger });
  // W2-11 启动自清扫：best-effort，任何异常吞掉不阻塞启动。
  void bootstrapReap({
    manager: processManager,
    snapshotPath: PID_SNAPSHOT_PATH,
    emit: (payload) => defaultBus.emit({ ...makeBase('process.reaped', 'startup-reap'), ...payload }),
  }).catch((e) => process.stderr.write(`[v2] startup-reap failed: ${(e as Error).message}\n`));
  // W2-4 父死子随：stdin EOF 始终监听（父进程关 stdin → 立即触发 shutdown）。
  // Electron backend.ts spawn 时 stdio[0] 是 'pipe'，Electron 退出即刻 EOF；
  // 作为 MCP proxy 子进程跑时同样成立。唯一不适用的是纯 CLI 直跑 server，
  // 此时 stdin 是 TTY，watchStdinEnd 内部 resume() 无副作用，'end' 不会触发。
  watchStdinEnd(trigger);
  watchParentAlive(trigger);     // W2-4 兜底：ppid 变 1（500ms 轮询）
  const server = createServer();
  reconcileStaleInstances();
  attachPortGuard(server, p);
  server.listen(p, () => {
    process.stderr.write(`[v2] listening on port ${p}\n`);
    writePidFile();
  });

  const subscriptionManager = new SubscriptionManager();
  const visibilityFilter = createVisibilityFilter(createFilterStore());
  const messageStore = createMessageStore();
  const broadcaster = new WsBroadcaster({ eventBus: defaultBus, subscriptionManager, visibilityFilter, messageStore });
  broadcaster.start();
  const comm = new CommServer({ driverDispatcher: createDriverDispatcher(driverRegistry), eventBus: defaultBus });
  const userSessions = new UserSessionTracker({ commRegistry: comm.registry });
  const notifStore = createNotificationStore();
  const proxyRouter = createProxyRouter({ store: notifStore, getPrimaryAgentInstanceId: () => primaryAgent.getConfig()?.id ?? null });
  const wss = attachWsUpgrade(server, {
    subscriptionManager, broadcaster, userSessions,
    handlerDeps: {
      subscriptionManager,
      driverRegistry,
      commRegistry: comm.registry,
      gapReplayDeps: { messageStore },
      commRouter: comm.router,
      lookupAgent: lookupAgentByInstanceId,
      primaryAgent,
      // 延迟获取：装配时 bootSubscribers 还没跑，getTurnAggregator() 暂时返回 null。
      getTurnAggregator,
      listTurnHistory: listRecentByDriver,
    },
    getPrimaryAgentRow: () => primaryAgent.getConfig(),
    getAgentState: () => primaryAgent.agentState,
  });
  setMessagesContext({ router: comm.router });
  const sockPath =
    process.env.TEAM_HUB_COMM_SOCK || join(homedir(), '.claude', 'team-hub', 'comm.sock');
  // cli/mcp 扫描不依赖 comm，提前执行与 comm.start 并行
  mcpManager.boot();
  cliManager.boot();
  let mcpHttpHandle: McpHttpHandle | null = null;
  let actionItemScheduler: ActionItemScheduler | null = null;
  // comm.start 与 mcp-http listen 无依赖，并行启动；主 Agent 只依赖 mcp-http（mteam-primary）
  // 红线：bootSubscribers 必须早于 primaryAgent.boot（EventBus 无 replay，晚订阅会丢 driver.started）
  Promise.all([
    comm.start(sockPath).then(() => {
      process.stderr.write(`[v2] comm listening at ${sockPath}\n`);
    }),
    startMcpHttpServer({ hubUrl: `http://localhost:${p}`, commRouter: comm.router }).then((h) => {
      mcpHttpHandle = h;
      process.stderr.write(`[v2] mcp-http listening at ${h.url}\n`);
    }),
  ])
    .then(() => {
      bootSubscribers({
        commRouter: comm.router,
        notification: {
          proxyRouter, commRouter: comm.router,
          getActiveUserId: () => userSessions.listActive()[0]?.userId ?? 'local',
          getPrimaryAgentInstanceId: () => primaryAgent.getConfig()?.id ?? null,
        },
      }, { sandbox: { enabled: process.env.TEAM_HUB_SANDBOX === '1', transport: (process.env.TEAM_HUB_MCP_TRANSPORT as 'http' | 'stdio') ?? 'stdio' }, policy: { enabled: process.env.TEAM_HUB_POLICY === '1' } });
      actionItemScheduler = createActionItemScheduler(globalTicker, defaultBus, comm.router);
      actionItemScheduler.boot();
      primaryAgent.boot();
    })
    .catch((e) => process.stderr.write(`[v2] startup failed: ${(e as Error).message}\n`));

  // 硬兜底：15s 内若 shutdown 未完成，强制退出（防 hang 住留守驻进程）。
  const SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
  shutdown = (): void => {
    const hardKill = setTimeout(() => {
      process.stderr.write('[v2] shutdown timeout, forcing exit\n');
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardKill.unref?.();

    void (async () => {
      broadcaster.stop();
      // teardownSubscribers → member-driver lifecycle 会 fire-and-forget 停 member driver；
      // 不等它完成，下面 processManager.killAll 会把所有仍注册的进程组打掉。
      teardownSubscribers();
      if (mcpHttpHandle) {
        try { await mcpHttpHandle.close(); }
        catch (e) { process.stderr.write(`[v2] mcp-http close failed: ${(e as Error).message}\n`); }
      }
      try { actionItemScheduler?.teardown(); } catch { /* ignore */ }
      mcpManager.teardown();
      cliManager.teardown();
      globalTicker.destroy();
      try { await primaryAgent.teardown(); }
      catch (e) { process.stderr.write(`[v2] primary-agent teardown failed: ${(e as Error).message}\n`); }
      // 最后兜底：processManager 里还存活的全部 kill（SIGTERM → 2s → SIGKILL）。
      // detached:true 让 agent driver 独立 PGID，-ppid 组播打不到，必须走这里。
      try { await processManager.killAll(); }
      catch (e) { process.stderr.write(`[v2] processManager killAll failed: ${(e as Error).message}\n`); }
      wss.close();
      try { await comm.stop(); } catch { /* ignore */ }
      await new Promise<void>((r) => server.close(() => r()));
      removePidFile();
      closeDb();
      clearTimeout(hardKill);
      process.exit(0);
    })();
  };
  process.on('SIGINT', trigger);
  process.on('SIGTERM', trigger);
  // 进程任何路径退出都清 pid 文件（包括 uncaughtException 在 shutdown 装配前触发的情况）。
  process.on('exit', () => removePidFile());
  return server;
}

const isDirectRun =
  typeof process.argv[1] === 'string' && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) startServer();
