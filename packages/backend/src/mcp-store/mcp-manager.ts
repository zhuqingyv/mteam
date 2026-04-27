// McpManager —— 运行时 MCP 可用性快照 + 模板解析器。
// boot() 从 store 拉全量快照并订阅 bus 的 mcp.installed/uninstalled 增量维护。
// resolve() 拿模板 availableMcps 清单，和快照求交集，对 __builtin__ 吐
// { kind: 'builtin', name: 'mteam', env, visibility }；非 builtin 吐
// { kind: 'user-stdio', command, args, env }。command/args/process.execPath
// 由下游 launch-spec-builder 决定（HTTP 还是 stdio）。
// 不可用的 MCP 名进 skipped，让上层决定是告警还是静默。
import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../bus/index.js';
import { listAll, findByName } from './store.js';
import type { McpConfig, ResolvedMcpSpec, ResolvedMcpSet } from './types.js';
import type {
  McpToolVisibility,
  TemplateMcpConfig,
} from '../domain/role-template.js';

export type { TemplateMcpConfig } from '../domain/role-template.js';
export type { ResolvedMcpSpec, ResolvedMcpSet } from './types.js';

export interface McpManagerContext {
  instanceId: string;
  hubUrl: string;
  commSock: string;
  isLeader: boolean;
}

const SEARCHTOOLS_MCP_NAME = 'searchTools';
const DEFAULT_VISIBILITY = { surface: '*' as const, search: '*' as const };

export class McpManager {
  private snapshot: Map<string, McpConfig> = new Map();
  private sub: Subscription | null = null;

  constructor(private readonly eventBus: EventBus = defaultBus) {}

  boot(): void {
    this.snapshot.clear();
    for (const cfg of listAll()) {
      this.snapshot.set(cfg.name, cfg);
    }
    const install = this.eventBus.on('mcp.installed').subscribe((e) => {
      try {
        const cfg = findByName(e.mcpName);
        if (cfg) this.snapshot.set(cfg.name, cfg);
      } catch (err) {
        process.stderr.write(
          `[mcp-manager] install handler error: ${(err as Error).message}\n`,
        );
      }
    });
    const uninstall = this.eventBus.on('mcp.uninstalled').subscribe((e) => {
      try {
        this.snapshot.delete(e.mcpName);
      } catch (err) {
        process.stderr.write(
          `[mcp-manager] uninstall handler error: ${(err as Error).message}\n`,
        );
      }
    });
    install.add(uninstall);
    this.sub = install;
  }

  teardown(): void {
    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = null;
    }
    this.snapshot.clear();
  }

  isAvailable(name: string): boolean {
    return this.snapshot.has(name);
  }

  checkTemplate(
    mcps: TemplateMcpConfig,
  ): { name: string; available: boolean }[] {
    return mcps.map((m) => ({ name: m.name, available: this.snapshot.has(m.name) }));
  }

  resolve(
    templateMcps: TemplateMcpConfig,
    ctx: McpManagerContext,
  ): ResolvedMcpSet {
    const specs: ResolvedMcpSpec[] = [];
    const skipped: string[] = [];

    for (const entry of templateMcps as McpToolVisibility[]) {
      // 兼容旧 schema（serverName/mode）和新 schema（name/surface/search）
      const entryName = entry.name ?? (entry as Record<string, unknown>).serverName as string | undefined;
      const cfg = entryName ? this.snapshot.get(entryName) : undefined;
      if (!cfg) {
        skipped.push(entryName ?? 'unknown');
        continue;
      }
      const mode = (entry as Record<string, unknown>).mode as string | undefined;
      const vis = {
        surface: entry.surface ?? (mode === 'all' ? '*' : DEFAULT_VISIBILITY.surface),
        search: entry.search ?? (mode === 'all' ? '*' : DEFAULT_VISIBILITY.search),
      };

      if (cfg.command === '__builtin__') {
        specs.push({
          kind: 'builtin',
          name: 'mteam',
          env: {
            ROLE_INSTANCE_ID: ctx.instanceId,
            V2_SERVER_URL: ctx.hubUrl,
            TEAM_HUB_COMM_SOCK: ctx.commSock,
            IS_LEADER: ctx.isLeader ? '1' : '0',
            MTEAM_TOOL_VISIBILITY: JSON.stringify(vis),
          },
          visibility: vis,
        });
      } else {
        specs.push({
          kind: 'user-stdio',
          name: entry.name,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        });
      }
    }

    // searchTools 无条件注入：每个角色实例都要有一个 search 入口查次屏工具。
    // 它不是模板可选项，也不走 store；env 仅需 ROLE_INSTANCE_ID + V2_SERVER_URL。
    specs.push({
      kind: 'builtin',
      name: SEARCHTOOLS_MCP_NAME,
      env: {
        ROLE_INSTANCE_ID: ctx.instanceId,
        V2_SERVER_URL: ctx.hubUrl,
      },
      visibility: { surface: '*', search: '*' },
    });

    return { specs, skipped };
  }

  // 主 Agent 专属注入：无条件产出 mteam-primary + searchTools，跳过 mteam，
  // 透传其他 user-stdio（如 mnemo）。不需要 commSock / isLeader —— 主 Agent
  // 的工具集（create_leader 等）不依赖成员通信通道，也不区分 leader/member。
  resolveForPrimary(
    templateMcps: TemplateMcpConfig,
    ctx: { instanceId: string; hubUrl: string },
  ): ResolvedMcpSet {
    const specs: ResolvedMcpSpec[] = [];
    const skipped: string[] = [];

    specs.push({
      kind: 'builtin',
      name: 'mteam-primary',
      env: {
        ROLE_INSTANCE_ID: ctx.instanceId,
        V2_SERVER_URL: ctx.hubUrl,
      },
      visibility: { surface: '*', search: '*' },
    });

    specs.push({
      kind: 'builtin',
      name: SEARCHTOOLS_MCP_NAME,
      env: {
        ROLE_INSTANCE_ID: ctx.instanceId,
        V2_SERVER_URL: ctx.hubUrl,
      },
      visibility: { surface: '*', search: '*' },
    });

    for (const entry of templateMcps as McpToolVisibility[]) {
      const entryName =
        entry.name ??
        ((entry as Record<string, unknown>).serverName as string | undefined);
      if (!entryName || entryName === 'mteam') {
        if (entryName === 'mteam') skipped.push(entryName);
        continue;
      }
      const cfg = this.snapshot.get(entryName);
      if (!cfg) {
        skipped.push(entryName);
        continue;
      }
      specs.push({
        kind: 'user-stdio',
        name: entryName,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
      });
    }

    return { specs, skipped };
  }
}

export const mcpManager = new McpManager();
