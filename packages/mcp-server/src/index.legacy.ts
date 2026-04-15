#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  acquireLock,
  takeover,
  releaseLock,
  readLock,
  updateLock,
  forceRelease,
} from "./lock-manager.js";
import {
  initSession,
  registerLockNonce,
  unregisterLockNonce,
  getLockNonce,
  markActivated,
  isActivated,
  markMemorySaved,
  hasMemorySaved,
  clearMemberTracking,
} from "./session-manager.js";
import {
  saveProfile,
  getProfile,
  listMembers,
  appendWorkLog,
  readWorkLog,
  type MemberProfile,
} from "./member-store.js";
import {
  saveMemory,
  readMemory,
  submitExperience,
  readShared,
  searchExperience,
} from "./memory-store.js";
import {
  proposeRule,
  reviewRules,
  approveRule,
  rejectRule,
} from "./rule-manager.js";
import { launchPanel, isPanelRunning } from "./panel-launcher.js";
import { DEFAULT_STUCK_TIMEOUT_MINUTES } from "./constants.js";
import {
  touchHeartbeat,
  readHeartbeat,
  removeHeartbeat,
  scanStaleHeartbeats,
  HEARTBEAT_TIMEOUT_MS,
} from "./heartbeat.js";
import {
  initProxy,
  proxyToolCall,
  loadMemberMcps,
  installMcp as installMcpConfig,
  uninstallMcp as uninstallMcpConfig,
  cleanupMember as cleanupMemberMcps,
  cleanupOneMcp,
  cleanupAll as cleanupAllMcps,
  getProxyStatus,
  listChildTools,
  preSpawnMcp,
  isChildRunning,
  loadStore,
  addToStore,
  removeFromStore,
  mountMcp,
  unmountMcp,
  type McpConfig,
} from "./mcp-proxy.js";

// ──────────────────────────────────────────────
// 目录初始化
// ──────────────────────────────────────────────
const HUB_DIR = path.join(os.homedir(), ".claude", "team-hub");
const MEMBERS_DIR = path.join(HUB_DIR, "members");
const SHARED_DIR = path.join(HUB_DIR, "shared");
const SESSIONS_DIR = path.join(HUB_DIR, "sessions");
const TEMPLATES_DIR = path.join(HUB_DIR, "templates");

for (const dir of [HUB_DIR, MEMBERS_DIR, SHARED_DIR, SESSIONS_DIR, TEMPLATES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 启动 session（清理孤儿锁、注册 stdin 关闭处理）
const { pid: sessionPid, lstart: sessionStart } = initSession(HUB_DIR);

// 初始化 MCP 代理层（子进程管理）
initProxy(HUB_DIR);

// 启动面板
launchPanel(HUB_DIR);

// ── 心跳巡检（60s 一次，清理超时 agent）─────────
const HEARTBEAT_SWEEP_INTERVAL_MS = 60_000;
setInterval(async () => {
  const staleMembers = scanStaleHeartbeats(MEMBERS_DIR, HEARTBEAT_TIMEOUT_MS);
  for (const member of staleMembers) {
    process.stderr.write(`[heartbeat-sweep] ${member} timed out, auto cleanup\n`);

    const lock = readLock(MEMBERS_DIR, member);
    if (lock && lock.session_pid === sessionPid) {
      const nonce = getLockNonce(member) ?? lock.nonce;
      const result = releaseLock(MEMBERS_DIR, member, nonce);
      if (result.success) {
        unregisterLockNonce(member);
        appendWorkLog(MEMBERS_DIR, member, {
          event: "check_out",
          timestamp: new Date().toISOString(),
          project: lock.project,
          task: lock.task,
          note: "auto-released by heartbeat timeout",
        });
      }
    }

    await cleanupMemberMcps(member);
    removeHeartbeat(MEMBERS_DIR, member);
    clearMemberTracking(member);
  }
}, HEARTBEAT_SWEEP_INTERVAL_MS);

// ──────────────────────────────────────────────
// UID → name 查找
// ──────────────────────────────────────────────
function findMemberByUid(uid: string): string | null {
  const members = listMembers(MEMBERS_DIR);
  const found = members.find((m) => m.uid === uid);
  return found?.name ?? null;
}

// ──────────────────────────────────────────────
// 权限检查（动态读 governance.json）
// ──────────────────────────────────────────────
function loadGovernance(): Record<string, unknown> {
  const govPath = path.join(SHARED_DIR, "governance.json");
  try {
    return JSON.parse(fs.readFileSync(govPath, "utf-8"));
  } catch {
    return {};
  }
}

function checkPrivilege(caller: string, action: string): void {
  const gov = loadGovernance();
  const permissions = gov.permissions as Record<string, string[]> | undefined;

  // 动态查 governance.json 中对应 action 的权限列表
  const actionKey = action.replace("_", "_"); // normalize
  const allowed = permissions?.[actionKey] ?? permissions?.["approve_rule"] ?? [];

  const profile = getProfile(MEMBERS_DIR, caller);
  const isPrivileged =
    allowed.includes(caller) || (profile?.role === "leader");

  if (!isPrivileged) {
    throw new Error(`caller '${caller}' does not have permission to ${action}`);
  }
}

// ──────────────────────────────────────────────
// 项目管理
// ──────────────────────────────────────────────
type ProjectStatus = "planning" | "designing" | "developing" | "testing" | "bugfixing" | "done" | "abandoned";

interface ProjectData {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  members: string[];
  experience: string;
  forbidden: string[];
  rules: string[];
  created_at: string;
  updated_at: string;
}

const PROJECTS_DIR = path.join(SHARED_DIR, "projects");
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

function readProjectFile(id: string): ProjectData | null {
  const filePath = path.join(PROJECTS_DIR, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProjectData;
  } catch {
    return null;
  }
}

function writeProjectFile(project: ProjectData): void {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${project.id}.json`), JSON.stringify(project, null, 2));
}

function listAllProjects(): ProjectData[] {
  const files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".json"));
  const projects: ProjectData[] = [];
  for (const file of files) {
    try {
      projects.push(JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, file), "utf-8")));
    } catch { /* skip */ }
  }
  const order: Record<string, number> = { developing: 0, testing: 1, bugfixing: 2, designing: 3, planning: 4, done: 5, abandoned: 6 };
  projects.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.updated_at.localeCompare(a.updated_at));
  return projects;
}

// ──────────────────────────────────────────────
// MCP Server
// ──────────────────────────────────────────────
const server = new Server(
  { name: "mcp-team-hub", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ──────────────────────────────────────────────
// Tool 定义
// ──────────────────────────────────────────────
const tools = [
  // ── 状态管理 ──────────────────────────────
  {
    name: "check_in",
    description: "成员签到，获取工作锁。→ 通常由 request_member 自动完成，成员一般不需要手动调。如手动调了 check_in，接下来必须 activate 获取角色定义和记忆。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        project: { type: "string", description: "项目名" },
        task: { type: "string", description: "任务描述" },
      },
      required: ["member", "project", "task"],
    },
  },
  {
    name: "check_out",
    description: "成员签出，释放工作锁。→ 优先使用 deactivate（会同时清理 MCP 子进程和心跳）。check_out 仅释放锁不清心跳。默认要求先 save_memory，传 force=true 跳过。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        note: { type: "string", description: "完成备注（可选）" },
        force: { type: "boolean", description: "跳过经验保存检查（会记录到日志）" },
      },
      required: ["member"],
    },
  },
  {
    name: "get_status",
    description: "查询成员当前状态（working/online/offline、项目、任务）。→ leader 在分配任务前确认目标成员状态。返回值含 last_seen。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名，不填则返回全员状态" },
      },
      required: [],
    },
  },
  {
    name: "force_release",
    description: "强制释放某成员的锁（需要 leader 权限）。→ stuck_scan 发现卡住成员后调此工具释放锁，然后决定是否重新分配任务。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "调用者名" },
        member: { type: "string", description: "被释放锁的成员名" },
      },
      required: ["caller", "member"],
    },
  },
  // ── 记忆 ──────────────────────────────────
  {
    name: "save_memory",
    description: "保存成员的私有记忆（generic 通用或 project 项目专属）。check_out/deactivate 前必须调用。→ 保存后如有团队级教训，继续调 submit_experience 贡献给全团队。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
        content: { type: "string" },
        project: { type: "string", description: "scope=project 时必填" },
      },
      required: ["member", "scope", "content"],
    },
  },
  {
    name: "read_memory",
    description: "读取成员的私有记忆。activate 已自动返回记忆，此工具用于中途查阅自己或其他成员的经验。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
        project: { type: "string" },
      },
      required: ["member"],
    },
  },
  {
    name: "submit_experience",
    description: "提交经验到共享区（generic/project/team）。→ 每次有值得全团队知道的教训或发现时调用，不仅限于 check_out 前。scope=team 会进入规则审批流程。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project", "team"] },
        content: { type: "string" },
        project: { type: "string" },
      },
      required: ["member", "scope", "content"],
    },
  },
  {
    name: "read_shared",
    description: "读取共享区内容（experience/rules/pending_rules）。→ 查看团队积累的经验和现行规则。搜索特定关键词用 search_experience 更高效。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["experience", "rules", "pending_rules"] },
        scope: { type: "string", enum: ["generic", "project"] },
        project: { type: "string" },
      },
      required: ["type"],
    },
  },
  {
    name: "search_experience",
    description: "在共享经验中搜索关键词。→ 成员开工前应搜索任务相关关键词，复用前人经验，避免重复踩坑。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"] },
      },
      required: ["keyword"],
    },
  },
  // ── 制度 ──────────────────────────────────
  {
    name: "propose_rule",
    description: "提议新规则（进入待审队列）。→ 任何成员发现需要全团队遵守的规则时调用。提交后通知 leader 调 review_rules 审批。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        rule: { type: "string" },
        reason: { type: "string" },
      },
      required: ["member", "rule", "reason"],
    },
  },
  {
    name: "review_rules",
    description: "查看待审规则列表。→ leader 定期检查是否有待审规则。有则逐条 approve_rule 或 reject_rule。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "approve_rule",
    description: "批准待审规则，移入 rules.md（需要 leader 权限）。→ 审批后规则立即生效，所有成员下次 activate 时自动获取。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        rule_id: { type: "string" },
      },
      required: ["caller", "rule_id"],
    },
  },
  {
    name: "reject_rule",
    description: "拒绝待审规则并说明原因（需要 leader 权限）。→ 拒绝后提议者会在下次 read_shared(pending_rules) 时看到。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        rule_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["caller", "rule_id", "reason"],
    },
  },
  // ── 招募 ──────────────────────────────────
  {
    name: "hire_temp",
    description: "雇用临时成员（需要 leader 权限）。→ 团队人手不足时创建临时角色。创建后用 request_member + spawn Agent 启动。任务结束后 evaluate_temp 评估留用。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        name: { type: "string" },
        display_name: { type: "string" },
        role: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["caller", "name", "display_name", "role"],
    },
  },
  {
    name: "evaluate_temp",
    description: "评价临时成员，决定留用或解散（需要 leader 权限）。→ 临时成员完成任务后必须评估。convert_to_permanent=true 转正，否则后续不再分配任务。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string" },
        member: { type: "string" },
        score: { type: "number", description: "1-10" },
        comment: { type: "string" },
        convert_to_permanent: { type: "boolean" },
      },
      required: ["caller", "member", "score", "comment"],
    },
  },
  {
    name: "list_templates",
    description: "列出可用的成员模板。→ hire_temp 前可先看有没有合适的模板，复用已有角色定义。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ── 看板 ──────────────────────────────────
  {
    name: "team_report",
    description: "全队状态快照：谁在干什么，谁空闲。→ leader 每轮派发后应调一次确认分配结果，验收前调一次确认全员完成。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "project_dashboard",
    description: "项目看板：某项目下所有成员的工作状态。→ 成员开工前调一次了解同项目其他人分工，leader 用于跟踪项目进展。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      required: ["project"],
    },
  },
  {
    name: "work_history",
    description: "查询成员工作历史（check_in/check_out/handoff 记录）。→ leader 验收前查看成员实际工作轨迹，评估工作质量。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        limit: { type: "number", description: "最多返回条数，默认 20" },
      },
      required: ["member"],
    },
  },
  {
    name: "stuck_scan",
    description: "扫描疑似卡住的成员（持锁超时）。→ leader 定期调用。发现卡住成员后：SendMessage 催促 → 无响应则 force_release → 重新分配任务。",
    inputSchema: {
      type: "object",
      properties: {
        timeout_minutes: { type: "number", description: "超时分钟数，默认 120（2h）" },
      },
      required: [],
    },
  },
  {
    name: "handoff",
    description: "交接：成员将任务移交给另一个成员。→ 自动释放 from 的锁并为 to 获取锁。to 需要 activate 获取上下文后继续工作。",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        note: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
  // ── 人事管理 ──────────────────────────────
  {
    name: "request_member",
    description: "申请团队成员加入项目（spawn 前必调）。每个成员在同一 session 中只允许一个实例。→ 返回 granted=true 后 spawn Agent；返回 existing=true 必须用 SendMessage 联系已有实例，严禁重新 spawn。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "申请人（leader 的 call_name）" },
        member: { type: "string", description: "要申请的成员 call_name" },
        project: { type: "string", description: "项目名" },
        task: { type: "string", description: "任务描述" },
      },
      required: ["caller", "member", "project", "task"],
    },
  },
  {
    name: "activate",
    description: "成员激活，获取角色定义和记忆。成员 spawn 后第一件事调用此工具。如果你的 agent name 包含数字后缀（如 laochui-2），说明你是重复实例，必须立即通知 team lead 并停止工作。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "自己的 call_name" },
      },
      required: ["member"],
    },
  },
  {
    name: "deactivate",
    description: "成员下线。释放锁、清理 MCP 子进程、删除心跳。成员结束工作或被 leader 关闭前调用。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员 call_name" },
        note: { type: "string", description: "下线备注" },
        force: { type: "boolean", description: "跳过经验保存检查" },
      },
      required: ["member"],
    },
  },
  {
    name: "release_member",
    description: "主动释放成员锁（需要 leader 权限）。→ 成员异常退出、需要重新分配时使用。会清理心跳和状态追踪。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "调用者" },
        member: { type: "string", description: "被释放的成员" },
      },
      required: ["caller", "member"],
    },
  },
  // ── 团队治理查询 ──────────────────────────
  {
    name: "get_roster",
    description: "获取完整团队花名册 + 治理关系 + 忙闲状态。→ leader 接到任务后第一步调此工具，查看可用人员和角色。返回 summary.hint 会提示人员状况和建议。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_team_rules",
    description: "获取团队协作规则：核心共识、交付门禁、验收链。→ leader 派发任务前确认当前规则，成员 activate 已自动返回团队规则。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ── MCP 代理 ──────────────────────────────
  {
    name: "proxy_tool",
    description: "代理调用成员的自定义 MCP 工具（需要成员 UID）。team-hub 按需启动子 MCP 进程、转发调用、返回结果。→ 调用前确认 MCP 已挂载（list_member_mcps），未挂载先 mount_mcp。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "成员 UID" },
        mcp_name: { type: "string", description: "目标 MCP 名称" },
        tool_name: { type: "string", description: "要调用的工具名" },
        arguments: { type: "object", description: "工具参数" },
      },
      required: ["uid", "mcp_name", "tool_name"],
    },
  },
  {
    name: "list_member_mcps",
    description: "查询成员已配置的 MCP 列表（含商店全量 + 挂载/运行状态）。→ 成员 activate 后查看自己可用的工具集，按需 mount_mcp 挂载。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "成员 UID" },
      },
      required: ["uid"],
    },
  },
  {
    name: "install_member_mcp",
    description: "为成员安装自定义 MCP 服务（需要 leader 权限）。→ 安装后成员可通过 proxy_tool 调用。批量部署建议先 install_store_mcp 再让成员自行 mount_mcp。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        member: { type: "string", description: "目标成员 name" },
        mcp_name: { type: "string", description: "MCP 名称" },
        command: { type: "string", description: "启动命令" },
        args: { type: "array", items: { type: "string" }, description: "命令参数" },
        env: { type: "object", description: "环境变量（可选）" },
        description: { type: "string", description: "MCP 描述（可选）" },
      },
      required: ["caller", "member", "mcp_name", "command", "args"],
    },
  },
  {
    name: "uninstall_member_mcp",
    description: "卸载成员的自定义 MCP 服务（需要 leader 权限）。→ 自动清理运行中的子进程。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        member: { type: "string", description: "目标成员 name" },
        mcp_name: { type: "string", description: "MCP 名称" },
      },
      required: ["caller", "member", "mcp_name"],
    },
  },
  {
    name: "proxy_status",
    description: "查看当前所有活跃的子 MCP 进程状态。→ leader 排查 MCP 相关问题时使用，查看哪些子进程在运行。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "cleanup_member_mcps",
    description: "强制清理成员的所有子 MCP 进程（需要 leader 权限）。→ 成员异常退出后 deactivate 未正常执行时使用。正常流程下 deactivate 会自动清理。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        member: { type: "string", description: "目标成员 name" },
      },
      required: ["caller", "member"],
    },
  },
  // ── MCP 商店 ──────────────────────────────
  {
    name: "install_store_mcp",
    description: "将 MCP 安装到团队商店（需要 leader 权限）。→ 商店中的 MCP 所有成员可自行 mount_mcp 挂载，无需逐人 install。适合全团队通用工具。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        mcp_name: { type: "string", description: "MCP 名称（唯一标识）" },
        command: { type: "string", description: "启动命令（如 npx, node, bun）" },
        args: { type: "array", items: { type: "string" }, description: "命令参数" },
        env: { type: "object", description: "环境变量（可选）" },
        description: { type: "string", description: "MCP 功能描述" },
      },
      required: ["caller", "mcp_name", "command", "args"],
    },
  },
  {
    name: "uninstall_store_mcp",
    description: "从团队商店移除 MCP（需要 leader 权限）。→ 移除后已挂载的成员下次 deactivate 时自动清理。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        mcp_name: { type: "string", description: "MCP 名称" },
      },
      required: ["caller", "mcp_name"],
    },
  },
  {
    name: "list_store_mcps",
    description: "列出团队 MCP 商店中所有可用的 MCP。→ 成员查看可挂载的工具集，用 mount_mcp 挂载需要的。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "mount_mcp",
    description: "成员从团队商店挂载 MCP 到自己的可用列表（需要成员 UID）。支持热挂载。→ 挂载后用 proxy_tool 调用其中的工具。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "成员 UID" },
        mcp_name: { type: "string", description: "要挂载的 MCP 名称（必须在商店中）" },
      },
      required: ["uid", "mcp_name"],
    },
  },
  {
    name: "unmount_mcp",
    description: "成员卸载已挂载的 MCP（需要成员 UID）。→ 自动清理该 MCP 的运行中子进程。deactivate 时会自动清理所有 MCP，一般无需手动卸载。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "成员 UID" },
        mcp_name: { type: "string", description: "要卸载的 MCP 名称" },
      },
      required: ["uid", "mcp_name"],
    },
  },
  // ── 项目管理 ──────────────────────────────
  {
    name: "create_project",
    description: "创建新项目。→ 创建前先调 list_projects 检查是否有可复用项目。创建后应立即调 add_project_rule 设置 forbidden 和 rules。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        name: { type: "string", description: "项目名称" },
        description: { type: "string", description: "项目描述" },
        members: { type: "array", items: { type: "string" }, description: "初始成员名单" },
      },
      required: ["caller", "name"],
    },
  },
  {
    name: "get_project",
    description: "获取项目详情：成员、进度、经验、规则（forbidden/rules）、状态。→ 成员中途需要回顾项目约束时调用。activate 已返回 project_rules，此工具看更多细节。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "list_projects",
    description: "列出所有项目，按状态排序（活跃优先）。→ leader 接到新任务后先调此工具，检查是否有相似项目可复用。如有疑似相似，咨询用户是否关联已有项目。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "update_project",
    description: "更新项目属性（状态、进度、描述、成员、经验、规则）。→ 里程碑节点更新 status 和 progress，通知相关成员。leader 验收后更新为 done。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        project_id: { type: "string", description: "项目 ID" },
        status: { type: "string", enum: ["planning", "designing", "developing", "testing", "bugfixing", "done", "abandoned"] },
        progress: { type: "number", description: "进度 0-100" },
        description: { type: "string" },
        members: { type: "array", items: { type: "string" }, description: "成员列表（全量替换）" },
        experience: { type: "string", description: "项目经验" },
        forbidden: { type: "array", items: { type: "string" }, description: "绝对禁止（全量替换）" },
        rules: { type: "array", items: { type: "string" }, description: "绝对遵循（全量替换）" },
      },
      required: ["caller", "project_id"],
    },
  },
  {
    name: "add_project_experience",
    description: "追加项目经验（不覆盖，在已有内容后追加）。→ 成员完成子任务后记录经验教训，后续成员 activate 时可读到。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "提交人" },
        project_id: { type: "string", description: "项目 ID" },
        content: { type: "string", description: "经验内容" },
      },
      required: ["member", "project_id", "content"],
    },
  },
  {
    name: "add_project_rule",
    description: "为项目添加一条 forbidden（绝对禁止）或 rules（必须遵循）规则。→ 创建项目后 leader 设置约束。成员 activate 时自动获取这些规则。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        project_id: { type: "string", description: "项目 ID" },
        type: { type: "string", enum: ["forbidden", "rules"], description: "forbidden=绝对禁止, rules=绝对遵循" },
        content: { type: "string", description: "规则内容" },
      },
      required: ["caller", "project_id", "type", "content"],
    },
  },
  {
    name: "get_project_rules",
    description: "获取项目的 forbidden 和 rules。→ activate 已自动返回 project_rules，此工具用于 leader 检查或成员中途确认规则。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "checkpoint",
    description: "任务检查点：返回你的原始任务、项目规则、验收标准。→ 每完成一个子任务后调用，对比当前产出与初始目标，检查是否遗漏或偏离。如发现偏差，修正后再继续下一步。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员 call_name" },
        progress_summary: { type: "string", description: "当前完成了什么（简述）" },
      },
      required: ["member"],
    },
  },
  {
    name: "delete_project",
    description: "删除项目（需要 leader 权限）。→ 仅在项目确认废弃时使用，删除不可恢复。正常结束的项目应 update_project(status='done')。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "操作人" },
        project_id: { type: "string", description: "项目 ID" },
      },
      required: ["caller", "project_id"],
    },
  },
] as const;

// ──────────────────────────────────────────────
// Tool handlers
// ──────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  function str(key: string): string {
    const v = a[key];
    if (typeof v !== "string") throw new Error(`missing or invalid param: ${key}`);
    return v;
  }
  function optStr(key: string): string | undefined {
    const v = a[key];
    return typeof v === "string" ? v : undefined;
  }
  function num(key: string, def: number): number {
    const v = a[key];
    return typeof v === "number" ? v : def;
  }
  function bool(key: string, def: boolean): boolean {
    const v = a[key];
    return typeof v === "boolean" ? v : def;
  }

  function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  try {
    // ── 心跳：每次工具调用自动更新 ──
    const _hbMember = optStr("member") ?? optStr("from") ?? (() => {
      const uid = optStr("uid");
      return uid ? findMemberByUid(uid) : null;
    })();
    if (_hbMember && isActivated(_hbMember)) {
      touchHeartbeat(MEMBERS_DIR, _hbMember, sessionPid, name);
    }

    switch (name) {
      // ── check_in ──────────────────────────
      case "check_in": {
        const member = str("member");
        const project = str("project");
        const task = str("task");

        const existing = readLock(MEMBERS_DIR, member);

        if (existing) {
          if (existing.session_pid === sessionPid) {
            // 分支1：自己持锁 → 更新任务
            const knownNonce = getLockNonce(member) ?? existing.nonce;
            const result = updateLock(MEMBERS_DIR, member, knownNonce, project, task);
            if (result.success) {
              appendWorkLog(MEMBERS_DIR, member, {
                event: "check_in",
                timestamp: new Date().toISOString(),
                project,
                task,
                note: "task updated (re-check_in)",
              });
            }
            return ok({ ...result, action: "updated" });
          } else {
            // 分支2/3：他人持锁 → 尝试 takeover（内部判断进程是否已死）
            const result = takeover(
              MEMBERS_DIR,
              member,
              sessionPid,
              sessionStart,
              project,
              task
            );
            if (result.success) {
              const lock = readLock(MEMBERS_DIR, member);
              if (lock) registerLockNonce(member, lock.nonce);
              appendWorkLog(MEMBERS_DIR, member, {
                event: "check_in",
                timestamp: new Date().toISOString(),
                project,
                task,
                note: `takeover from pid ${existing.session_pid}`,
              });
            }
            return ok({ ...result, action: result.success ? "takeover" : "rejected" });
          }
        }

        // 无锁 → 正常抢锁
        const result = acquireLock(
          MEMBERS_DIR,
          member,
          sessionPid,
          sessionStart,
          project,
          task
        );

        if (result.success) {
          const lock = readLock(MEMBERS_DIR, member);
          if (lock) registerLockNonce(member, lock.nonce);

          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_in",
            timestamp: new Date().toISOString(),
            project,
            task,
          });
        }
        return ok({ ...result, action: result.success ? "acquired" : "failed" });
      }

      // ── check_out ─────────────────────────
      case "check_out": {
        const member = str("member");
        const note = optStr("note");
        const force = bool("force", false);

        const lock = readLock(MEMBERS_DIR, member);
        if (!lock) {
          return ok({ success: false, error: "not checked in" });
        }

        // 检查是否已保存经验（activate 过的成员才检查）
        if (isActivated(member) && !hasMemorySaved(member) && !force) {
          return ok({
            success: false,
            error: "请先调用 save_memory 保存本次工作经验，再 check_out。如确实无经验可存，传 force=true 跳过。",
          });
        }

        const result = releaseLock(MEMBERS_DIR, member, lock.nonce);
        if (result.success) {
          unregisterLockNonce(member);
          const checkoutNote = force && !hasMemorySaved(member)
            ? `${note ?? ""} [⚠️ 跳过经验保存]`.trim()
            : note;
          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_out",
            timestamp: new Date().toISOString(),
            project: lock.project,
            task: lock.task,
            note: checkoutNote,
          });
          clearMemberTracking(member);
          removeHeartbeat(MEMBERS_DIR, member);
          // 清理该成员的子 MCP 进程
          await cleanupMemberMcps(member);
        }
        return ok(result);
      }

      // ── deactivate ────────────────────────
      case "deactivate": {
        const member = str("member");
        const note = optStr("note");
        const force = bool("force", false);

        if (!isActivated(member)) {
          return ok({ success: false, error: "成员未激活" });
        }

        const lock = readLock(MEMBERS_DIR, member);

        // 经验保存检查
        if (lock && !hasMemorySaved(member) && !force) {
          return ok({
            success: false,
            error: "请先调用 save_memory 保存本次工作经验，再 deactivate。传 force=true 跳过。",
          });
        }

        // 释放锁
        if (lock) {
          const nonce = getLockNonce(member) ?? lock.nonce;
          const result = releaseLock(MEMBERS_DIR, member, nonce);
          if (result.success) {
            unregisterLockNonce(member);
            appendWorkLog(MEMBERS_DIR, member, {
              event: "check_out",
              timestamp: new Date().toISOString(),
              project: lock.project,
              task: lock.task,
              note: `deactivated${note ? ": " + note : ""}`,
            });
          }
        }

        // 清理 MCP 子进程
        await cleanupMemberMcps(member);
        // 删心跳
        removeHeartbeat(MEMBERS_DIR, member);
        // 清内存追踪
        clearMemberTracking(member);

        return ok({ success: true, member, note: note ?? null });
      }

      // ── get_status ────────────────────────
      case "get_status": {
        const member = optStr("member");
        if (member) {
          const lock = readLock(MEMBERS_DIR, member);
          const profile = getProfile(MEMBERS_DIR, member);
          const hb = readHeartbeat(MEMBERS_DIR, member);
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          const status = lock && online ? "working" : online ? "online" : "offline";
          return ok({ member, profile, lock, status, online, working: !!lock, last_seen: hb?.last_seen });
        }
        const members = listMembers(MEMBERS_DIR);
        const statuses = members.map((m) => {
          const lock = readLock(MEMBERS_DIR, m.name);
          const hb = readHeartbeat(MEMBERS_DIR, m.name);
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          const status = lock && online ? "working" : online ? "online" : "offline";
          return { uid: m.uid, member: m.name, display_name: m.display_name, role: m.role, status, online, working: !!lock, last_seen: hb?.last_seen, lock };
        });
        return ok(statuses);
      }

      // ── force_release ─────────────────────
      case "force_release": {
        const caller = str("caller");
        const member = str("member");
        checkPrivilege(caller, "force_release");
        const result = forceRelease(MEMBERS_DIR, member);
        if (result.success) unregisterLockNonce(member);
        return ok(result);
      }

      // ── save_memory ───────────────────────
      case "save_memory": {
        const member = str("member");
        if (!isActivated(member)) {
          return ok({ error: `成员 ${member} 未激活，请先调用 activate` });
        }
        const scope = str("scope") as "generic" | "project";
        const content = str("content");
        const project = optStr("project");
        saveMemory(MEMBERS_DIR, member, scope, content, project);
        markMemorySaved(member);
        return ok({
          success: true,
          hint: "→ 如有团队级教训，继续调 submit_experience 贡献给全团队。然后 deactivate(member=你自己) 下线。",
        });
      }

      // ── read_memory ───────────────────────
      case "read_memory": {
        const member = str("member");
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const project = optStr("project");
        const content = readMemory(MEMBERS_DIR, member, scope, project);
        return ok({ member, content });
      }

      // ── submit_experience ─────────────────
      case "submit_experience": {
        const member = str("member");
        if (!isActivated(member)) {
          return ok({ error: `成员 ${member} 未激活，请先调用 activate` });
        }
        const scope = str("scope") as "generic" | "project" | "team";
        const content = str("content");
        const project = optStr("project");
        const result = submitExperience(MEMBERS_DIR, SHARED_DIR, member, scope, content, project);
        markMemorySaved(member);
        const resp: Record<string, unknown> = { success: true };
        if (result.similar_lines.length > 0) {
          resp.warning = "similar content may already exist";
          resp.similar_lines = result.similar_lines;
        }
        return ok(resp);
      }

      // ── read_shared ───────────────────────
      case "read_shared": {
        const type = str("type") as "experience" | "rules" | "pending_rules";
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const project = optStr("project");
        const content = readShared(SHARED_DIR, type, scope, project);
        return ok({ content });
      }

      // ── search_experience ─────────────────
      case "search_experience": {
        const keyword = str("keyword");
        const scope = optStr("scope") as "generic" | "project" | undefined;
        const results = searchExperience(SHARED_DIR, keyword, scope);
        return ok({ keyword, results });
      }

      // ── propose_rule ──────────────────────
      case "propose_rule": {
        const member = str("member");
        const rule = str("rule");
        const reason = str("reason");
        const result = proposeRule(SHARED_DIR, member, rule, reason);
        return ok(result);
      }

      // ── review_rules ──────────────────────
      case "review_rules": {
        const rules = reviewRules(SHARED_DIR);
        return ok(rules);
      }

      // ── approve_rule ──────────────────────
      case "approve_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        checkPrivilege(caller, "approve_rule");
        const result = approveRule(SHARED_DIR, ruleId, caller);
        return ok(result);
      }

      // ── reject_rule ───────────────────────
      case "reject_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        const reason = str("reason");
        checkPrivilege(caller, "reject_rule");
        const result = rejectRule(SHARED_DIR, ruleId, reason);
        return ok(result);
      }

      // ── hire_temp ─────────────────────────
      case "hire_temp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const name = str("name");
        const displayName = str("display_name");
        const role = str("role");
        const skills = Array.isArray(a["skills"])
          ? (a["skills"] as string[])
          : [];
        const description = optStr("description");
        const profile: MemberProfile = {
          uid: crypto.randomUUID(),
          name,
          display_name: displayName,
          role,
          type: "temporary",
          joined_at: new Date().toISOString(),
          skills,
          description,
        };
        saveProfile(MEMBERS_DIR, profile);
        return ok({ success: true, profile });
      }

      // ── evaluate_temp ─────────────────────
      case "evaluate_temp": {
        const caller = str("caller");
        checkPrivilege(caller, "evaluate_temp");
        const member = str("member");
        const score = num("score", 0);
        const comment = str("comment");
        const convertToPermanent = bool("convert_to_permanent", false);

        const profile = getProfile(MEMBERS_DIR, member);
        if (!profile) return ok({ success: false, error: "member not found" });

        const evalEntry = {
          evaluator: caller,
          score,
          comment,
          evaluated_at: new Date().toISOString(),
          converted: convertToPermanent,
        };
        const evalPath = path.join(MEMBERS_DIR, member, "evaluations.jsonl");
        fs.appendFileSync(evalPath, JSON.stringify(evalEntry) + "\n", "utf-8");

        if (convertToPermanent) {
          profile.type = "permanent";
          saveProfile(MEMBERS_DIR, profile);
        }

        return ok({ success: true, evaluation: evalEntry });
      }

      // ── list_templates ────────────────────
      case "list_templates": {
        const templates: unknown[] = [];
        if (fs.existsSync(TEMPLATES_DIR)) {
          for (const f of fs.readdirSync(TEMPLATES_DIR)) {
            if (!f.endsWith(".json")) continue;
            try {
              const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8");
              templates.push({ file: f, ...JSON.parse(raw) });
            } catch {
              // 跳过损坏文件
            }
          }
        }
        return ok(templates);
      }

      // ── team_report ───────────────────────
      case "team_report": {
        const members = listMembers(MEMBERS_DIR);
        const working: unknown[] = [];
        const idle: unknown[] = [];
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (lock) {
            working.push({ uid: m.uid, name: m.name, display_name: m.display_name, role: m.role, lock });
          } else {
            idle.push({ uid: m.uid, name: m.name, display_name: m.display_name, role: m.role });
          }
        }
        return ok({ working, idle, total: members.length });
      }

      // ── project_dashboard ─────────────────
      case "project_dashboard": {
        const project = str("project");
        const members = listMembers(MEMBERS_DIR);
        const result: unknown[] = [];
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (lock && lock.project === project) {
            result.push({ uid: m.uid, name: m.name, display_name: m.display_name, task: lock.task, locked_at: lock.locked_at });
          }
        }
        return ok({ project, members: result });
      }

      // ── work_history ──────────────────────
      case "work_history": {
        const member = str("member");
        const limit = num("limit", 20);
        const logs = readWorkLog(MEMBERS_DIR, member);
        return ok({ member, history: logs.slice(-limit) });
      }

      // ── stuck_scan ────────────────────────
      case "stuck_scan": {
        const timeoutMinutes = num("timeout_minutes", DEFAULT_STUCK_TIMEOUT_MINUTES);
        const now = Date.now();
        const stuck: unknown[] = [];
        const members = listMembers(MEMBERS_DIR);
        for (const m of members) {
          const lock = readLock(MEMBERS_DIR, m.name);
          if (!lock) continue;
          const lockedAt = new Date(lock.locked_at).getTime();
          const elapsed = (now - lockedAt) / 60000;
          if (elapsed > timeoutMinutes) {
            stuck.push({ name: m.name, lock, elapsed_minutes: Math.round(elapsed) });
          }
        }
        return ok({ stuck, timeout_minutes: timeoutMinutes });
      }

      // ── handoff ───────────────────────────
      case "handoff": {
        const from = str("from");
        const to = str("to");
        const note = optStr("note");

        const fromLock = readLock(MEMBERS_DIR, from);
        if (!fromLock) return ok({ success: false, error: `${from} is not checked in` });

        const relResult = releaseLock(MEMBERS_DIR, from, fromLock.nonce);
        if (!relResult.success) return ok(relResult);
        unregisterLockNonce(from);

        appendWorkLog(MEMBERS_DIR, from, {
          event: "check_out",
          timestamp: new Date().toISOString(),
          project: fromLock.project,
          task: fromLock.task,
          note: `handoff to ${to}: ${note ?? ""}`,
        });

        const acqResult = acquireLock(
          MEMBERS_DIR,
          to,
          sessionPid,
          sessionStart,
          fromLock.project,
          fromLock.task
        );
        if (acqResult.success) {
          const toLock = readLock(MEMBERS_DIR, to);
          if (toLock) registerLockNonce(to, toLock.nonce);
          appendWorkLog(MEMBERS_DIR, to, {
            event: "check_in",
            timestamp: new Date().toISOString(),
            project: fromLock.project,
            task: fromLock.task,
            note: `handoff from ${from}: ${note ?? ""}`,
          });
        }

        return ok({ success: acqResult.success, from, to, project: fromLock.project, task: fromLock.task });
      }

      // ── request_member ────────────────────
      case "request_member": {
        const caller = str("caller");
        const member = str("member");
        const project = str("project");
        const task = str("task");

        // 检查成员是否存在
        const profile = getProfile(MEMBERS_DIR, member);
        if (!profile) {
          return ok({ granted: false, reason: `成员 ${member} 不存在` });
        }

        const existing = readLock(MEMBERS_DIR, member);

        if (!existing) {
          // 无锁 → 直接获取锁
          const result = acquireLock(MEMBERS_DIR, member, sessionPid, sessionStart, project, task);
          if (result.success) {
            const lock = readLock(MEMBERS_DIR, member);
            if (lock) registerLockNonce(member, lock.nonce);
            appendWorkLog(MEMBERS_DIR, member, {
              event: "check_in",
              timestamp: new Date().toISOString(),
              project,
              task,
              note: `requested by ${caller}`,
            });
          }
          return ok({ granted: result.success, member_info: profile, error: result.error });
        }

        if (existing.session_pid === sessionPid) {
          // 同 session → 已在本 session 工作
          return ok({ granted: true, note: "⚠️ 该成员已在本session中激活。请用 SendMessage 给现有实例发消息，禁止重新 spawn。", member_info: profile, existing: true });
        }

        // 他人 session → 尝试 takeover（内部判断进程是否已死）
        const takeResult = takeover(MEMBERS_DIR, member, sessionPid, sessionStart, project, task);
        if (takeResult.success) {
          const lock = readLock(MEMBERS_DIR, member);
          if (lock) registerLockNonce(member, lock.nonce);
          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_in",
            timestamp: new Date().toISOString(),
            project,
            task,
            note: `takeover by ${caller} from pid ${existing.session_pid}`,
          });
          return ok({ granted: true, member_info: profile });
        }

        return ok({
          granted: false,
          reason: `成员正在 ${existing.project} 项目工作，由session ${existing.session_pid} 占用`,
        });
      }

      // ── activate ──────────────────────────
      case "activate": {
        const member = str("member");

        const lock = readLock(MEMBERS_DIR, member);
        if (!lock) {
          return ok({ error: "未经申请，请先通过 request_member 申请" });
        }

        markActivated(member);
        touchHeartbeat(MEMBERS_DIR, member, sessionPid, "activate");

        // ── 基础信息 ──
        const profile = getProfile(MEMBERS_DIR, member);
        const personaPath = path.join(MEMBERS_DIR, member, "persona.md");
        const persona = fs.existsSync(personaPath)
          ? fs.readFileSync(personaPath, "utf-8")
          : "";

        const memory_generic = readMemory(MEMBERS_DIR, member, "generic");
        const memory_project = readMemory(MEMBERS_DIR, member, "project", lock.project);
        const team_rules = readShared(SHARED_DIR, "rules");

        // ── 对抗对象（从 governance.json 读 adversarial_pairs）──
        let peer_pair: { partner: string; relationship: string } | null = null;
        try {
          const gov = loadGovernance();
          const pairs = gov.adversarial_pairs as Array<{ roles: string[]; description?: string }> | undefined;
          if (pairs) {
            for (const pair of pairs) {
              const idx = pair.roles.indexOf(member);
              if (idx !== -1) {
                const partner = pair.roles[1 - idx];
                peer_pair = { partner, relationship: pair.description ?? `互审对象：${partner}` };
                break;
              }
            }
          }
        } catch { /* governance 读取失败不影响激活 */ }

        // ── 项目规则 + 同项目成员 ──
        let project_rules: { forbidden: string[]; rules: string[] } | null = null;
        let project_members: string[] = [];
        const allProjects = listAllProjects();
        const currentProject = allProjects.find(
          (p) => p.name === lock.project || p.members.includes(member)
        );
        if (currentProject) {
          project_rules = { forbidden: currentProject.forbidden, rules: currentProject.rules };
          project_members = currentProject.members.filter((m) => m !== member);
        }

        return ok({
          identity: {
            uid: profile?.uid ?? member,
            name: member,
            display_name: profile?.display_name ?? member,
            role: profile?.role ?? "unknown",
          },
          persona,
          memory_generic,
          memory_project,
          current_task: { project: lock.project, task: lock.task },
          team_rules,
          peer_pair,
          project_rules,
          project_members,
          workflow_hint: [
            "→ 你已激活。执行顺序：",
            "1. 阅读上面的 persona（你的角色定义）和 team_rules（团队规则）",
            peer_pair ? `2. 你的审计对象是 ${peer_pair.partner}（${peer_pair.relationship}），完成后找对方 review` : "2. 无指定审计对象",
            project_rules ? "3. 注意 project_rules 中的 forbidden（绝对禁止）和 rules（必须遵守）" : "3. 当前项目无特殊规则",
            "4. 调 search_experience(keyword) 搜索相关经验，避免重复踩坑",
            "5. 开始执行任务",
            "6. 每完成一个子任务后调 checkpoint(member=你自己) 自查：是否偏离目标、有无遗漏",
            "7. 全部完成后：save_memory → deactivate(member=你自己)",
          ].join("\n"),
        });
      }

      // ── release_member ────────────────────
      case "release_member": {
        const caller = str("caller");
        const member = str("member");
        checkPrivilege(caller, "release_member");

        const lock = readLock(MEMBERS_DIR, member);
        if (!lock) {
          return ok({ success: false, error: "成员未持锁" });
        }

        const result = releaseLock(MEMBERS_DIR, member, lock.nonce);
        if (result.success) {
          unregisterLockNonce(member);
          clearMemberTracking(member);
          removeHeartbeat(MEMBERS_DIR, member);
          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_out",
            timestamp: new Date().toISOString(),
            project: lock.project,
            task: lock.task,
            note: `released by ${caller}`,
          });
        }
        return ok(result);
      }

      // ── get_roster ────────────────────────
      case "get_roster": {
        const members = listMembers(MEMBERS_DIR);
        const roster = members.map((m) => {
          const lock = readLock(MEMBERS_DIR, m.name);
          const hb = readHeartbeat(MEMBERS_DIR, m.name);
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          const memberStatus = lock && online ? "working" : online ? "online" : "offline";
          return {
            uid: m.uid,
            name: m.name,
            display_name: m.display_name,
            role: m.role,
            type: m.type,
            status: memberStatus,
            current_project: lock?.project ?? null,
            current_task: lock?.task ?? null,
            last_seen: hb?.last_seen ?? null,
          };
        });

        // 读取治理数据
        const govPath = path.join(SHARED_DIR, "governance.json");
        let governance: unknown = null;
        try {
          governance = JSON.parse(fs.readFileSync(govPath, "utf-8"));
        } catch {
          governance = { error: "governance.json not found" };
        }

        // ── 汇总信息，引导 leader ──
        const workingCount = roster.filter((r) => r.status === "working").length;
        const onlineCount = roster.filter((r) => r.status === "online").length;
        const offlineCount = roster.filter((r) => r.status === "offline").length;
        const roleSet = new Set(roster.filter((r) => r.status !== "working").map((r) => r.role));
        const busyRoles = new Set(roster.filter((r) => r.status === "working").map((r) => r.role));
        const unavailableRoles = [...busyRoles].filter((r) => !roleSet.has(r));

        const hints: string[] = [];
        if (offlineCount > 0) hints.push(`${offlineCount} 人离线可调用`);
        if (workingCount > 0) hints.push(`${workingCount} 人工作中`);
        if (unavailableRoles.length > 0) hints.push(`角色全忙: ${unavailableRoles.join("、")}，如需可 hire_temp 临时招聘`);
        if (workingCount === roster.length) hints.push("⚠️ 全员忙碌，建议告知用户等待或扩编");

        return ok({
          roster,
          governance,
          summary: {
            total: roster.length,
            working: workingCount,
            online: onlineCount,
            offline: offlineCount,
            available_roles: [...roleSet],
            unavailable_roles: unavailableRoles,
            hint: hints.join("。") || "团队空闲，可分配任务",
          },
        });
      }

      // ── get_team_rules ────────────────────
      case "get_team_rules": {
        const rules = readShared(SHARED_DIR, "rules");
        const govPath = path.join(SHARED_DIR, "governance.json");
        let governance: unknown = null;
        try {
          governance = JSON.parse(fs.readFileSync(govPath, "utf-8"));
        } catch {
          // 无治理文件
        }
        return ok({
          rules,
          acceptance_chain: (governance as any)?.acceptance_chain ?? [],
          acceptance_rule: (governance as any)?.acceptance_rule ?? "",
        });
      }

      // ── MCP 代理工具 ────────────────────────
      case "proxy_tool": {
        const uid = str("uid");
        const mcpName = str("mcp_name");
        const toolName = str("tool_name");
        const toolArgs = (a["arguments"] ?? {}) as Record<string, unknown>;

        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在`);

        const result = await proxyToolCall(MEMBERS_DIR, memberName, mcpName, toolName, toolArgs);
        return ok(result);
      }

      case "list_member_mcps": {
        const uid = str("uid");
        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在`);

        // 最新商店列表
        const store = loadStore();
        // 成员已挂载列表
        const mounted = loadMemberMcps(MEMBERS_DIR, memberName);
        const mountedNames = new Set(mounted.map((m) => m.name));

        // 合并：商店全量 + 挂载/运行状态
        const result = store.map((item) => {
          const isMounted = mountedNames.has(item.name);
          const running = isMounted && isChildRunning(memberName, item.name);
          return {
            name: item.name,
            description: item.description,
            command: item.command,
            mounted: isMounted,
            running,
          };
        });

        return ok({ member: memberName, uid, store_mcps: result });
      }

      case "install_member_mcp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp"); // 复用人事权限
        const member = str("member");
        const mcpName = str("mcp_name");
        const command = str("command");
        const mcpArgs = Array.isArray(a["args"]) ? (a["args"] as string[]) : [];
        const env = (a["env"] ?? undefined) as Record<string, string> | undefined;
        const description = optStr("description");

        const config: McpConfig = { name: mcpName, command, args: mcpArgs, env, description };
        installMcpConfig(MEMBERS_DIR, member, config);
        return ok({ success: true, member, mcp: config });
      }

      case "uninstall_member_mcp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const member = str("member");
        const mcpName = str("mcp_name");

        // 先清理运行中的子进程
        const configs = loadMemberMcps(MEMBERS_DIR, member);
        const hasIt = configs.some((c) => c.name === mcpName);
        if (hasIt) {
          await cleanupMemberMcps(member); // 清理该成员所有子 MCP 后重新启动剩余的
        }

        const removed = uninstallMcpConfig(MEMBERS_DIR, member, mcpName);
        return ok({ success: removed, member, mcp_name: mcpName });
      }

      case "proxy_status": {
        return ok(getProxyStatus());
      }

      case "cleanup_member_mcps": {
        const caller = str("caller");
        checkPrivilege(caller, "force_release");
        const member = str("member");
        const cleaned = await cleanupMemberMcps(member);
        return ok({ success: true, member, cleaned_mcps: cleaned });
      }

      // ── MCP 商店 ────────────────────────────
      case "install_store_mcp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const mcpName = str("mcp_name");
        const command = str("command");
        const mcpArgs = Array.isArray(a["args"]) ? (a["args"] as string[]) : [];
        const env = (a["env"] ?? undefined) as Record<string, string> | undefined;
        const description = optStr("description");

        const config: McpConfig = { name: mcpName, command, args: mcpArgs, env, description };
        addToStore(config);
        return ok({ success: true, mcp: config, store: loadStore() });
      }

      case "uninstall_store_mcp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const mcpName = str("mcp_name");
        const removed = removeFromStore(mcpName);
        return ok({ success: removed, mcp_name: mcpName });
      }

      case "list_store_mcps": {
        return ok({ store: loadStore() });
      }

      case "mount_mcp": {
        const uid = str("uid");
        const mcpName = str("mcp_name");
        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在`);

        const result = mountMcp(MEMBERS_DIR, memberName, mcpName);
        if (!result.success) return ok({ ...result, member: memberName, mcp_name: mcpName });

        // 成员已激活 → 立刻启动子 MCP 进程
        let preSpawned = false;
        let tools: string[] = [];
        if (isActivated(memberName)) {
          try {
            tools = await preSpawnMcp(MEMBERS_DIR, memberName, mcpName);
            preSpawned = true;
          } catch (e) {
            // spawn 失败不影响挂载配置，下次调用时重试
          }
        }

        return ok({
          ...result,
          member: memberName,
          mcp_name: mcpName,
          pre_spawned: preSpawned,
          tools,
        });
      }

      case "unmount_mcp": {
        const uid = str("uid");
        const mcpName = str("mcp_name");
        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在`);

        // 只杀这一个子 MCP 进程
        await cleanupOneMcp(memberName, mcpName);

        const result = unmountMcp(MEMBERS_DIR, memberName, mcpName);
        return ok({ ...result, member: memberName, mcp_name: mcpName });
      }

      // ── checkpoint ────────────────────────
      case "checkpoint": {
        const member = str("member");
        const progressSummary = optStr("progress_summary") ?? "";

        if (!isActivated(member)) {
          return ok({ error: "成员未激活，无法检查点" });
        }

        const lock = readLock(MEMBERS_DIR, member);
        if (!lock) {
          return ok({ error: "成员无工作锁，无法获取任务信息" });
        }

        // 原始任务
        const originalTask = { project: lock.project, task: lock.task };

        // 项目规则
        const allProjects = listAllProjects();
        const currentProject = allProjects.find(
          (p) => p.name === lock.project || p.members.includes(member)
        );
        const projectRules = currentProject
          ? { forbidden: currentProject.forbidden, rules: currentProject.rules }
          : null;

        // 验收链（从 governance.json）
        let acceptanceChain: unknown = null;
        let acceptanceRule: string = "";
        try {
          const gov = loadGovernance();
          acceptanceChain = (gov as any).acceptance_chain ?? null;
          acceptanceRule = (gov as any).acceptance_rule ?? "";
        } catch { /* ignore */ }

        // 团队规则
        const teamRules = readShared(SHARED_DIR, "rules");

        return ok({
          checkpoint: true,
          original_task: originalTask,
          project_rules: projectRules,
          team_rules: teamRules,
          acceptance_chain: acceptanceChain,
          acceptance_rule: acceptanceRule,
          your_progress: progressSummary,
          verification_prompt: [
            "⚠️ 检查点 — 请对照以下问题自查：",
            `1. 你的任务是「${lock.task}」，当前产出是否完整覆盖了这个任务？`,
            "2. 有没有偷懒跳过的部分？有没有遗漏的边界情况？",
            projectRules && projectRules.forbidden.length > 0
              ? `3. 是否违反了 forbidden 规则：${projectRules.forbidden.join("；")}`
              : "3. 无特殊禁忌",
            projectRules && projectRules.rules.length > 0
              ? `4. 是否遵守了 rules：${projectRules.rules.join("；")}`
              : "4. 无特殊规则",
            "5. 如有偏差，先修正再继续下一步。",
            "6. 如已完成全部任务 → save_memory → deactivate。",
          ].join("\n"),
        });
      }

      // ── 项目管理工具 ───────────────────────
      case "create_project": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const projName = str("name");
        const description = optStr("description") ?? "";
        const members = Array.isArray(a["members"]) ? (a["members"] as string[]) : [];
        const now = new Date().toISOString();
        const project: ProjectData = {
          id: crypto.randomUUID(),
          name: projName,
          description,
          status: "planning",
          progress: 0,
          members,
          experience: "",
          forbidden: [],
          rules: [],
          created_at: now,
          updated_at: now,
        };
        writeProjectFile(project);
        return ok(project);
      }

      case "get_project": {
        const projectId = str("project_id");
        const project = readProjectFile(projectId);
        if (!project) return ok({ error: "项目不存在" });
        return ok(project);
      }

      case "list_projects": {
        const projects = listAllProjects();
        const activeCount = projects.filter((p) => !["done", "abandoned"].includes(p.status)).length;
        return ok({
          projects,
          active_count: activeCount,
          hint: activeCount > 0
            ? `当前有 ${activeCount} 个活跃项目。接到新任务时先检查是否与已有项目相关，避免重复创建。`
            : "暂无活跃项目。",
        });
      }

      case "update_project": {
        const caller = str("caller");
        const projectId = str("project_id");
        const project = readProjectFile(projectId);
        if (!project) return ok({ error: "项目不存在" });

        if (a["status"]) project.status = a["status"] as ProjectStatus;
        if (typeof a["progress"] === "number") project.progress = Math.min(100, Math.max(0, a["progress"] as number));
        if (typeof a["description"] === "string") project.description = a["description"] as string;
        if (Array.isArray(a["members"])) project.members = a["members"] as string[];
        if (typeof a["experience"] === "string") project.experience = a["experience"] as string;
        if (Array.isArray(a["forbidden"])) project.forbidden = a["forbidden"] as string[];
        if (Array.isArray(a["rules"])) project.rules = a["rules"] as string[];
        project.updated_at = new Date().toISOString();

        writeProjectFile(project);
        return ok(project);
      }

      case "add_project_experience": {
        const member = str("member");
        const projectId = str("project_id");
        const content = str("content");
        const project = readProjectFile(projectId);
        if (!project) return ok({ error: "项目不存在" });

        const stamp = `\n\n---\n[${member}] ${new Date().toISOString().slice(0, 10)}\n${content}`;
        project.experience = (project.experience + stamp).trim();
        project.updated_at = new Date().toISOString();
        writeProjectFile(project);
        return ok({ success: true, project_id: projectId });
      }

      case "add_project_rule": {
        const caller = str("caller");
        const projectId = str("project_id");
        const ruleType = str("type") as "forbidden" | "rules";
        const content = str("content");
        const project = readProjectFile(projectId);
        if (!project) return ok({ error: "项目不存在" });

        project[ruleType].push(content);
        project.updated_at = new Date().toISOString();
        writeProjectFile(project);
        return ok({ success: true, type: ruleType, total: project[ruleType].length });
      }

      case "get_project_rules": {
        const projectId = str("project_id");
        const project = readProjectFile(projectId);
        if (!project) return ok({ error: "项目不存在" });
        return ok({
          project_id: projectId,
          name: project.name,
          status: project.status,
          forbidden: project.forbidden,
          rules: project.rules,
        });
      }

      case "delete_project": {
        const caller = str("caller");
        checkPrivilege(caller, "force_release");
        const projectId = str("project_id");
        const filePath = path.join(PROJECTS_DIR, `${projectId}.json`);
        if (!fs.existsSync(filePath)) return ok({ success: false, error: "项目不存在" });
        fs.rmSync(filePath);
        return ok({ success: true, project_id: projectId });
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    const e = err as Error;
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
});

// ──────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mcp-team-hub] server started, hub=${HUB_DIR}, session_pid=${sessionPid}\n`);
