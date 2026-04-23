// McpManager —— 运行时 MCP 可用性快照 + 模板解析器。
// boot() 从 store 拉全量快照并订阅 bus 的 mcp.installed/uninstalled 增量维护。
// resolve() 拿模板 availableMcps 清单，和快照求交集，对 __builtin__ 注入
// IS_LEADER / MTEAM_TOOL_VISIBILITY 等 env；非 builtin 直接透传 store 里的
// command/args/env。不可用的 MCP 名进 skipped，让上层决定是告警还是静默。
import type { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../bus/index.js';
import { listAll, findByName } from './store.js';
import type { McpConfig } from './types.js';
import type {
  McpToolVisibility,
  TemplateMcpConfig,
} from '../domain/role-template.js';

export type { TemplateMcpConfig } from '../domain/role-template.js';

export interface McpManagerContext {
  instanceId: string;
  hubUrl: string;
  commSock: string;
  isLeader: boolean;
}

export interface McpConfigJson {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;
}

export interface ResolvedMcpSet {
  configJson: McpConfigJson;
  visibility: Record<string, { surface: string[] | '*'; search: string[] | '*' }>;
  skipped: string[];
}

// __builtin__ command 入口解析：MTEAM_MCP_ENTRY 指向 backend/src/mcp/index.js。
// searchTools 跟 mteam 平级的内置 MCP，由 resolve() 无条件注入，不出现在 store/模板里。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MTEAM_MCP_ENTRY = join(__dirname, '..', 'mcp', 'index.js');
const SEARCHTOOLS_MCP_ENTRY = join(__dirname, '..', 'searchtools', 'index.js');
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
    const mcpServers: McpConfigJson['mcpServers'] = {};
    const visibility: ResolvedMcpSet['visibility'] = {};
    const skipped: string[] = [];

    for (const entry of templateMcps as McpToolVisibility[]) {
      const cfg = this.snapshot.get(entry.name);
      if (!cfg) {
        skipped.push(entry.name);
        continue;
      }
      const vis = {
        surface: entry.surface ?? DEFAULT_VISIBILITY.surface,
        search: entry.search ?? DEFAULT_VISIBILITY.search,
      };
      visibility[entry.name] = vis;

      if (cfg.command === '__builtin__') {
        mcpServers[entry.name] = {
          command: process.execPath,
          args: [MTEAM_MCP_ENTRY],
          env: {
            ROLE_INSTANCE_ID: ctx.instanceId,
            V2_SERVER_URL: ctx.hubUrl,
            TEAM_HUB_COMM_SOCK: ctx.commSock,
            IS_LEADER: ctx.isLeader ? '1' : '0',
            MTEAM_TOOL_VISIBILITY: JSON.stringify(vis),
          },
        };
      } else {
        mcpServers[entry.name] = {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        };
      }
    }

    // searchTools 无条件注入：每个角色实例都要有一个 search 入口查次屏工具。
    // 它不是模板可选项，也不走 store；env 仅需 ROLE_INSTANCE_ID + V2_SERVER_URL。
    mcpServers[SEARCHTOOLS_MCP_NAME] = {
      command: process.execPath,
      args: [SEARCHTOOLS_MCP_ENTRY],
      env: {
        ROLE_INSTANCE_ID: ctx.instanceId,
        V2_SERVER_URL: ctx.hubUrl,
      },
    };

    return { configJson: { mcpServers }, visibility, skipped };
  }
}

export const mcpManager = new McpManager();
