#!/usr/bin/env bun
// Team Hub — 单进程 HTTP 服务
// 持有所有业务逻辑与状态，供 thin MCP stdio 代理通过 HTTP 调用

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

import {
  acquireLock,
  takeover,
  releaseLock,
  readLock,
  updateLock,
  forceRelease,
  scanOrphanLocks,
  isProcessAlive,
} from "./lock-manager.js";
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
  listChildToolDetails,
  preSpawnMcp,
  isChildRunning,
  loadStore,
  addToStore,
  removeFromStore,
  mountMcp,
  unmountMcp,
  type McpConfig,
  type ToolInfo,
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

const PROJECTS_DIR = path.join(SHARED_DIR, "projects");
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ──────────────────────────────────────────────
// HTTP 服务配置
// ──────────────────────────────────────────────
const HUB_HOST = "127.0.0.1";
const HUB_PORT = 58578;

// ──────────────────────────────────────────────
// Panel API helper
// ──────────────────────────────────────────────
function getPanelUrl(): string | null {
  try {
    const port = parseInt(fs.readFileSync(path.join(HUB_DIR, "panel.port"), "utf-8").trim(), 10);
    if (!isNaN(port)) return `http://127.0.0.1:${port}`;
  } catch {}
  return null;
}

async function callPanel<T>(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  body?: unknown,
  timeoutMs = 2000
): Promise<T> {
  const panelUrl = getPanelUrl();
  if (!panelUrl) throw new Error("Panel 未运行，无法执行此操作");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${panelUrl}${endpoint}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const json = (await res.json()) as Record<string, unknown>;

    // Panel 非 2xx → 抛错，让 catch 走本地回退
    if (!res.ok) {
      throw new Error((json?.error as string) ?? `Panel returned ${res.status}`);
    }

    // Panel API 统一 { ok, data } 包裹 — 解包 data
    if (json && json.ok !== undefined && "data" in json) {
      return json.data as T;
    }

    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────
// Per-session 状态
// ──────────────────────────────────────────────
interface SessionState {
  id: string;
  pid: number;
  lstart: string;
  memberName: string; // CLAUDE_MEMBER env var at registration time (empty for leader)
  isLeader: boolean;
  activatedMembers: Set<string>;
  memorySavedMembers: Set<string>;
  lockNonces: Map<string, string>; // memberName -> nonce
  registeredAt: string;
  lastActivity: number;
}

const sessions = new Map<string, SessionState>();

// ──────────────────────────────────────────────
// 预约（Reservation）机制 — 磁盘格式
// ──────────────────────────────────────────────
interface Reservation {
  code: string;        // UUID 预约码
  member: string;
  caller: string;
  project: string;
  task: string;
  session_id: string;
  created_at: number;  // Date.now()
  ttl_ms: number;      // 默认 210000 (3分30秒)
  previous_member?: string;  // 前任成员名（任务交接场景）
}

// 预约状态落盘（供 Panel 实时检测）
function writeReservationFile(member: string, res: Reservation): void {
  const filePath = path.join(MEMBERS_DIR, member, "reservation.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(res), "utf-8");
  } catch { /* 目录可能不存在，忽略 */ }
}

function readReservationFile(member: string): Reservation | null {
  const filePath = path.join(MEMBERS_DIR, member, "reservation.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Reservation;
  } catch {
    return null;
  }
}

function deleteReservationFile(member: string): void {
  try { fs.rmSync(path.join(MEMBERS_DIR, member, "reservation.json"), { force: true }); } catch {}
}

// ──────────────────────────────────────────────
// 离场状态持久化（departure.json）
// ──────────────────────────────────────────────
interface DepartureState {
  pending: boolean;
  requirement?: string;
  requested_at: string;
  previous_status?: string;  // 撤销时恢复用
}

function writeDepartureFile(member: string, state: DepartureState): void {
  const dir = path.join(MEMBERS_DIR, member);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "departure.json"), JSON.stringify(state), "utf-8");
}

function readDepartureFile(member: string): DepartureState | null {
  const filePath = path.join(MEMBERS_DIR, member, "departure.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DepartureState;
  } catch {
    return null;
  }
}

function deleteDepartureFile(member: string): void {
  try { fs.rmSync(path.join(MEMBERS_DIR, member, "departure.json"), { force: true }); } catch {}
}

function registerSession(pid: number, lstart: string, member: string = "", isLeader: boolean = false): string {
  const id = crypto.randomUUID();
  // isLeader 显式传入优先；向后兼容：member 为空视为 leader
  const leader = isLeader || member === "";
  const state: SessionState = {
    id,
    pid,
    lstart,
    memberName: member,
    isLeader: leader,
    activatedMembers: new Set(),
    memorySavedMembers: new Set(),
    lockNonces: new Map(),
    registeredAt: new Date().toISOString(),
    lastActivity: Date.now(),
  };
  sessions.set(id, state);
  process.stderr.write(`[hub] session registered: ${id} (pid=${pid}${member ? ` member=${member}` : ""}${leader ? " [leader]" : ""})\n`);
  return id;
}

async function unregisterSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  // 释放本 session 持有的所有锁
  if (fs.existsSync(MEMBERS_DIR)) {
    const entries = fs.readdirSync(MEMBERS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lock = readLock(MEMBERS_DIR, entry.name);
      if (lock && lock.session_pid === session.pid) {
        const nonce = session.lockNonces.get(entry.name) ?? lock.nonce;
        const result = releaseLock(MEMBERS_DIR, entry.name, nonce);
        if (result.success) {
          appendWorkLog(MEMBERS_DIR, entry.name, {
            event: "check_out",
            timestamp: new Date().toISOString(),
            project: lock.project,
            task: lock.task,
            note: "session unregistered",
          });
        }
      }
    }
  }

  // 清理已激活成员的心跳和 MCP 子进程
  for (const member of session.activatedMembers) {
    removeHeartbeat(MEMBERS_DIR, member);
    await cleanupMemberMcps(member);
  }

  sessions.delete(sessionId);
  process.stderr.write(`[hub] session unregistered: ${sessionId} (cleaned ${session.activatedMembers.size} members)\n`);
}

function touchSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.lastActivity = Date.now();
}

// ──────────────────────────────────────────────
// Helper 函数
// ──────────────────────────────────────────────
function findMemberByUid(uid: string): string | null {
  const members = listMembers(MEMBERS_DIR);
  const found = members.find((m) => m.uid === uid);
  return found?.name ?? null;
}

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
  const allowed = permissions?.[action] ?? permissions?.["approve_rule"] ?? [];
  const profile = getProfile(MEMBERS_DIR, caller);
  const isPrivileged = allowed.includes(caller) || profile?.role === "leader" || profile?.role === "总控";
  if (!isPrivileged) {
    throw new Error(`caller '${caller}' 没有 ${action} 权限。这是 leader 专用操作，请用 send_msg 联系 leader。`);
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
// 工具定义
// ──────────────────────────────────────────────
export const tools = [
  // ── 状态管理 ──────────────────────────────
  {
    name: "check_in",
    description: "【成员自己调用】activate 已自动签入。仅在同一 session 内需要切换到不同项目/任务时才手动调用。→ 切换记忆工作区的项目/任务绑定。",
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
    description: "【成员自己调用】底层释放工具。正常下线请用 deactivate，仅在 deactivate 失败时作为应急手段。→ 直接释放锁和清理，不含激活状态检查。默认要求先 save_memory，传 force=true 跳过。",
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
    description: "强制释放成员的记忆工作区（需要 leader 权限）。→ stuck_scan 发现卡住成员后调此工具释放，然后决定是否重新分配任务。",
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
    description: "【成员自己调用】保存工作记忆到持久化仓库（generic 通用或 project 项目专属）。deactivate 前必须调用。→ 如有团队级教训，继续调 submit_experience。返回值：{ saved: true }。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"], description: "记忆范围。scope='project' 时 project 必填" },
        content: { type: "string" },
        project: { type: "string", description: "项目名。仅 scope='project' 时需要" },
      },
      required: ["member", "scope", "content"],
    },
  },
  {
    name: "read_memory",
    description: "【成员自己调用】读取持久化记忆仓库中的内容。activate 已自动返回记忆，此工具用于中途查阅。→ 查团队共享经验用 read_shared 或 search_experience。返回值：{ content: string }。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        scope: { type: "string", enum: ["generic", "project"], description: "记忆范围。不填默认 generic。scope='project' 时 project 必填" },
        project: { type: "string", description: "项目名。仅 scope='project' 时需要，scope='generic' 时忽略" },
      },
      required: ["member"],
    },
  },
  {
    name: "submit_experience",
    description: "【成员自己调用】将经验保存到团队共享持久化仓库（generic/project/team）。→ 每次有值得全团队知道的教训或发现时调用，不仅限于 check_out 前。scope=team 会进入规则审批流程。",
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
        name: { type: "string", description: "成员名（汉字）" },
        role: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["caller", "name", "role"],
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
    description: "【leader 调用】扫描记忆工作区占用超时的成员。→ leader 定期调用。发现卡住成员后：SendMessage 催促 → 无响应则 force_release → 重新分配任务。",
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
    description: "交接：成员将任务移交给另一个成员。→ 自动释放 from 的锁并为 to 获取正式锁。交接后 to 成员的终端中会收到通知，to 需要调用 activate（无需 reservation_code，handoff 已自动转移正式锁）加载上下文后继续工作。交接完成后建议用 send_msg 通知接收方。返回值：{ success, from, to, project, task, hint? }。",
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
    description: "预约成员。auto_spawn=true 时预约成功后自动创建终端窗口，成员在独立窗口中工作。→ 预约有效期 3 分 30 秒。→ 推荐：auto_spawn=true 让成员在独立终端工作。返回值：成功时 { reserved:true, reservation_code, usage_hint, member_brief, spawn_result? }；失败时 { reserved:false, reason }。",
    inputSchema: {
      type: "object",
      properties: {
        caller: { type: "string", description: "申请人（leader 的 call_name）" },
        member: { type: "string", description: "要申请的成员 call_name" },
        project: { type: "string", description: "项目名" },
        task: { type: "string", description: "任务描述" },
        auto_spawn: { type: "boolean", description: "是否预约成功后自动创建终端窗口（默认 false）" },
        cli_name: { type: "string", description: "CLI 名称（auto_spawn=true 时使用，默认 'claude'）" },
        workspace_path: { type: "string", description: "工作目录路径（auto_spawn=true 时传给成员终端作为 cwd，同时预写 trust）" },
        previous_member: { type: "string", description: "前任成员名（可选）。任务交接场景使用：接班人 activate 时会看到前任信息，引导读取前任的记忆和工作历史" },
      },
      required: ["caller", "member", "project", "task"],
    },
  },
  {
    name: "cancel_reservation",
    description: "用预约码取消未使用的预约，释放成员回空闲状态。场景：决定不 spawn、重新选人前清理旧预约。→ 取消后该成员可被重新 request_member 预约。",
    inputSchema: {
      type: "object",
      properties: {
        reservation_code: { type: "string", description: "request_member 返回的预约码" },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "activate",
    description: "【成员自己调用，leader 不要调】用预约码激活记忆工作区：验证预约 → 转正式锁 → 加载人设、历史记忆、项目规则、协作关系。被 spawn 后第一件事调此工具。激活后返回：persona（人设）、memory_generic（通用记忆）、memory_project（项目记忆）、project_rules（项目规则）、team_rules（团队规则）、collaborators（同项目成员）。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "自己的 call_name" },
        reservation_code: { type: "string", description: "预约码（request_member 返回）。推荐必填。无预约码时走向后兼容流程（需已持有正式锁，如 handoff 转移的锁）" },
      },
      required: ["member"],
    },
  },
  {
    name: "deactivate",
    description: "【成员自己调用，标准下线路径】释放记忆工作区：释放锁、清理 MCP 子进程、删除心跳。与 check_out 区别：deactivate 含激活状态检查和经验保存提醒，是正常下线唯一入口；check_out 是底层操作，不要直接调用。标准流程：save_memory → deactivate。",
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
    description: "主动释放成员记忆工作区（需要 leader 权限）。比 force_release 更彻底：同时清理心跳、状态追踪。→ 成员异常退出、进程已死时使用此工具。成员还活着但卡住时用 force_release。",
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
    description: "查看团队花名册：成员名称、职业、简介、忙闲状态。分配任务前首选此工具查看全员状态。→ 选好人后调 request_member 预约。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_team_rules",
    description: "获取团队协作规则（核心共识、交付门禁、验收链）。成员 activate 已自动返回规则，无需重复调用。→ leader 在规则有争议或需要向用户说明时使用。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ── MCP 代理 ──────────────────────────────
  {
    name: "proxy_tool",
    description: "代理调用成员的自定义 MCP 工具（需要成员 UID）。uid 从 activate 返回值的 identity.uid 获取，或从 get_roster 返回的 roster[].uid 获取。team-hub 按需启动子 MCP 进程、转发调用、返回结果。→ 调用前先 list_member_mcps 查看已挂载 MCP 的可用工具名和参数 schema，未挂载先 mount_mcp。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "成员 UID（从 get_roster 或 activate 返回值获取）" },
        mcp_name: { type: "string", description: "目标 MCP 名称（从 list_member_mcps 获取）" },
        tool_name: { type: "string", description: "要调用的工具名（从 list_member_mcps 返回的 tools 列表获取）" },
        arguments: { type: "object", description: "工具参数（参照 list_member_mcps 返回的各工具 inputSchema）" },
      },
      required: ["uid", "mcp_name", "tool_name"],
    },
  },
  {
    name: "list_member_mcps",
    description: "查询成员已配置的 MCP 列表（含商店全量 + 挂载/运行状态 + 已挂载 MCP 的子工具列表）。uid 从 activate 返回值的 identity.uid 获取，或从 get_roster 返回的 roster[].uid 获取。→ 成员 activate 后查看自己可用的工具集，按需 mount_mcp 挂载。",
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
    description: "成员从团队商店挂载 MCP 到自己的可用列表（需要成员 UID）。uid 从 activate 返回值的 identity.uid 获取，或从 get_roster 返回的 roster[].uid 获取。支持热挂载。→ 挂载后用 proxy_tool 调用其中的工具。返回值含子工具列表（名称+参数 schema）。",
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
    description: "成员卸载已挂载的 MCP（需要成员 UID）。uid 从 activate 返回值的 identity.uid 获取，或从 get_roster 返回的 roster[].uid 获取。→ 自动清理该 MCP 的运行中子进程。deactivate 时会自动清理所有 MCP，一般无需手动卸载。",
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
        confirm_overwrite: { type: "boolean", description: "当数组字段（members/forbidden/rules）缩短时必须传 true 确认覆盖，默认 false" },
      },
      required: ["caller", "project_id"],
    },
  },
  {
    name: "add_project_experience",
    description: "追加项目经验（不覆盖，在已有内容后追加）。→ 成员完成子任务后记录经验教训。此经验存于项目 experience 字段，需通过 get_project 查看，activate 不自动加载。",
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
    description: "【由成员自己调用】任务检查点：返回原始任务、项目规则、验收标准。→ 每完成一个子任务后调用，对比产出与目标，检查遗漏或偏离。",
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
  // ── Agent CLI 管理 ──────────────────────────
  {
    name: "scan_agent_clis",
    description: "【Panel 内部/Leader 调用】扫描本地已安装的 agent CLI（claude/aider/gemini 等）。用于 auto_spawn 前确认目标 CLI 可用。返回值：{ found: [{name, path}], not_found: [string] }。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "spawn_pty_session",
    description: "【Panel 内部调用】在 Panel 中启动 agent CLI 的终端窗口。→ 指定成员和 CLI，会打开一个独立终端窗口运行该 CLI。一般通过 request_member(auto_spawn=true) 间接触发，无需直接调用。返回值：{ session_id, member, cli_name }。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        cli_name: { type: "string", description: "CLI 名称（如 claude）" },
        cli_bin: { type: "string", description: "CLI 二进制路径（可选，自动检测）" },
      },
      required: ["member", "cli_name"],
    },
  },
  {
    name: "list_pty_sessions",
    description: "【Leader/Panel 调用】列出运行中的 PTY session（成员名、CLI、状态）。用于查看当前所有成员终端窗口的运行情况。返回值：{ sessions: [{ session_id, memberId, cli_name, status, cwd? }] }。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "kill_pty_session",
    description: "【Leader 调用】终止 PTY session。→ 成员异常退出或卡住时强制关闭其终端窗口。正常流程下成员 deactivate 会自动退出。返回值：{ killed: boolean }。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID" },
      },
      required: ["session_id"],
    },
  },
  // ── 跨 Agent 消息 ──────────────────────────
  {
    name: "send_msg",
    description: "发消息给其他 agent。消息通过 PTY stdin 直接写入目标 agent 终端。from 由系统自动从当前 session 的 activated 成员推断，不需要也不能手动指定。→ 跨 agent 协作的主要通信方式，支持 leader 向成员下达指令、成员间互相协调。返回值：{ sent: boolean, delivery?: string }。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标成员名或 'leader'（回复 leader 消息时使用）" },
        content: { type: "string", description: "消息内容" },
        priority: { type: "string", enum: ["normal", "urgent"], description: "优先级（默认 normal）" },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "check_inbox",
    description: "消费收件箱消息（读取并清空队列）。注意：消息读取后将被清除，不可重复读取。→ 如需只读不消费，传 peek=true。返回值：{ messages: [{ from, content, priority, timestamp }] }。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员名" },
        peek: { type: "boolean", description: "只读不消费（默认 false）。peek=true 时消息保留在队列中不被清除" },
      },
      required: ["member"],
    },
  },
  // ── 离场系统 ──────────────────────────────
  {
    name: "request_departure",
    description: "【Leader 专用】发起/撤销成员离场请求。pending=true 标记成员为 pending_departure 并通过 PTY 通知成员；pending=false 撤销待离场状态。→ 这是异步状态标记，成员会自行处理收尾后调 clock_out 下班。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "目标成员名" },
        pending: { type: "boolean", description: "true=发起离场请求，false=撤销（默认 true）" },
        requirement: { type: "string", description: "离场要求文本（可选，如收尾事项）" },
      },
      required: ["member"],
    },
  },
  {
    name: "clock_out",
    description: "【成员专用】确认离场并执行下班流程：释放工作锁、清理 MCP 子进程、删除心跳、关闭终端窗口、通知 leader。→ 只有被 leader 标记为 pending_departure 的成员才能调用。→ 建议先 save_memory 保存经验再 clock_out，否则本次经验将丢失。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员 call_name" },
        note: { type: "string", description: "下班备注（可选）" },
        force: { type: "boolean", description: "跳过经验保存检查（默认 false）。仅在确实无经验可存时使用" },
      },
      required: ["member"],
    },
  },
  // ── 用户交互 ──────────────────────────────
  {
    name: "ask_user",
    description: "向用户发起交互式确认/选择/输入弹窗。弹窗会直接出现在用户桌面上，用户可以选择答案或等待超时。超时默认 2 分钟，自动返回拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["confirm", "single_choice", "multi_choice", "input"], description: "交互类型：confirm=是/否, single_choice=单选, multi_choice=多选, input=纯输入" },
        title: { type: "string", description: "弹窗标题（简短）" },
        question: { type: "string", description: "详细问题描述" },
        options: { type: "array", items: { type: "string" }, description: "选项列表（仅 single_choice/multi_choice 需要）" },
        timeout_ms: { type: "number", description: "超时毫秒数，默认 120000（2分钟）" },
      },
      required: ["type", "title", "question"],
    },
  },
  // ── API Key 保险柜 ──────────────────────────
  {
    name: "list_api_keys",
    description: "列出可用的 API Key 名称。只返回名称列表，不返回密钥值。用于查看哪些 API 可以通过 use_api 调用。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "use_api",
    description: "通过安全代理发起 API 请求。系统会自动注入对应的 API Key，你无需也无法看到密钥值。",
    inputSchema: {
      type: "object",
      properties: {
        api_name: { type: "string", description: "API 名称（通过 list_api_keys 查看可用值）" },
        url: { type: "string", description: "完整请求 URL" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP 方法，默认 POST" },
        headers: { type: "object", description: "额外的请求头（不需要传 Authorization，系统自动注入）" },
        body: { description: "请求体（对象或字符串）" },
      },
      required: ["api_name", "url"],
    },
  },
] as const;

// ──────────────────────────────────────────────
// handleToolCall：核心业务逻辑（per-session）
// ──────────────────────────────────────────────
export async function handleToolCall(
  session: SessionState,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const a = args;

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

  // Per-session state accessors
  const sessionPid = session.pid;
  const sessionStart = session.lstart;

  function isActivated(member: string): boolean {
    return session.activatedMembers.has(member);
  }
  function markActivated(member: string): void {
    session.activatedMembers.add(member);
  }
  function hasMemorySaved(member: string): boolean {
    return session.memorySavedMembers.has(member);
  }
  function markMemorySaved(member: string): void {
    session.memorySavedMembers.add(member);
  }
  function clearMemberTracking(member: string): void {
    session.activatedMembers.delete(member);
    session.memorySavedMembers.delete(member);
  }
  function getLockNonce(member: string): string | undefined {
    return session.lockNonces.get(member);
  }
  function registerLockNonce(member: string, nonce: string): void {
    session.lockNonces.set(member, nonce);
  }
  function unregisterLockNonce(member: string): void {
    session.lockNonces.delete(member);
  }

  try {
    // ── 心跳：每次工具调用自动更新 ──
    const _hbMember = optStr("member") ?? optStr("from") ?? (() => {
      const uid = optStr("uid");
      return uid ? findMemberByUid(uid) : null;
    })();
    if (_hbMember && isActivated(_hbMember)) {
      try {
        await callPanel("POST", `/api/member/${encodeURIComponent(_hbMember)}/heartbeat`, { session_pid: sessionPid, last_tool: toolName });
      } catch {
        touchHeartbeat(MEMBERS_DIR, _hbMember, sessionPid, toolName);
      }
    }

    switch (toolName) {
      // ── check_in ──────────────────────────
      case "check_in": {
        const member = str("member");
        const project = str("project");
        const task = str("task");
        const memberEnc = encodeURIComponent(member);

        let existing: { session_pid: number; nonce: string; locked_at: string; project: string; task: string } | null;
        try {
          existing = await callPanel<typeof existing>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          existing = readLock(MEMBERS_DIR, member);
        }

        if (existing) {
          if (existing.session_pid === sessionPid) {
            // 分支1：自己持锁 → 更新任务
            const knownNonce = getLockNonce(member) ?? existing.nonce;
            let result: { success: boolean; error?: string };
            try {
              result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/update`, { nonce: knownNonce, project, task });
            } catch {
              result = updateLock(MEMBERS_DIR, member, knownNonce, project, task);
            }
            if (result.success) {
              try {
                await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: "task updated (re-check_in)" });
              } catch {
                appendWorkLog(MEMBERS_DIR, member, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: "task updated (re-check_in)" });
              }
            }
            return ok({ ...result, action: "updated", hint: "→ 工作区已绑定，开始执行任务。完成后 save_memory → deactivate" });
          } else {
            // 分支2/3：他人持锁 → 尝试 takeover（内部判断进程是否已死）
            let result: { success: boolean; error?: string };
            try {
              result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/takeover`, { session_pid: sessionPid, session_start: sessionStart, project, task });
            } catch {
              result = takeover(MEMBERS_DIR, member, sessionPid, sessionStart, project, task);
            }
            if (result.success) {
              let lock: { nonce: string } | null;
              try {
                lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`);
              } catch {
                lock = readLock(MEMBERS_DIR, member);
              }
              if (lock) registerLockNonce(member, lock.nonce);
              try {
                await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: `takeover from pid ${existing.session_pid}` });
              } catch {
                appendWorkLog(MEMBERS_DIR, member, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: `takeover from pid ${existing.session_pid}` });
              }
            }
            return ok({
              ...result,
              action: result.success ? "takeover" : "rejected",
              hint: result.success
                ? "→ 工作区已绑定，开始执行任务。完成后 save_memory → deactivate"
                : "→ 当前被其他 session 占用且对方进程仍活跃，联系 leader 调 force_release 后重试",
            });
          }
        }

        // 无锁 → 正常抢锁
        let result: { success: boolean; error?: string };
        try {
          result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/acquire`, { session_pid: sessionPid, session_start: sessionStart, project, task });
        } catch {
          result = acquireLock(MEMBERS_DIR, member, sessionPid, sessionStart, project, task);
        }

        if (result.success) {
          let lock: { nonce: string } | null;
          try {
            lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`);
          } catch {
            lock = readLock(MEMBERS_DIR, member);
          }
          if (lock) registerLockNonce(member, lock.nonce);

          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project, task });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, { event: "check_in", timestamp: new Date().toISOString(), project, task });
          }
        }
        return ok({
          ...result,
          action: result.success ? "acquired" : "failed",
          ...(result.success ? { hint: "→ 工作区已绑定，开始执行任务。完成后 save_memory → deactivate" } : {}),
        });
      }

      // ── check_out ─────────────────────────
      case "check_out": {
        const member = str("member");
        const note = optStr("note");
        const force = bool("force", false);
        const memberEnc = encodeURIComponent(member);

        let lock: { nonce: string; project: string; task: string } | null;
        try {
          lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          lock = readLock(MEMBERS_DIR, member);
        }
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

        let result: { success: boolean; error?: string };
        try {
          result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/release`, { nonce: lock.nonce });
        } catch {
          result = releaseLock(MEMBERS_DIR, member, lock.nonce);
        }
        if (result.success) {
          unregisterLockNonce(member);
          const checkoutNote = force && !hasMemorySaved(member)
            ? `${note ?? ""} [⚠️ 跳过经验保存]`.trim()
            : note;
          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: checkoutNote });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: checkoutNote });
          }
          clearMemberTracking(member);
          try {
            await callPanel("DELETE", `/api/member/${memberEnc}/heartbeat`);
          } catch {
            removeHeartbeat(MEMBERS_DIR, member);
          }
          // 清理该成员的子 MCP 进程
          await cleanupMemberMcps(member);
        }
        return ok({
          ...result,
          ...(result.success ? { hint: "→ 工作锁已释放。如需同时清理 MCP 子进程和心跳，建议改用 deactivate 作为标准下线路径" } : {}),
        });
      }

      // ── deactivate ────────────────────────
      case "deactivate": {
        const member = str("member");
        const note = optStr("note");
        const force = bool("force", false);
        const memberEnc = encodeURIComponent(member);

        if (!isActivated(member)) {
          return ok({ success: false, error: "成员未激活，无需 deactivate。如需释放残留锁，用 check_out(force=true)" });
        }

        let lock: { nonce: string; project: string; task: string } | null;
        try {
          lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          lock = readLock(MEMBERS_DIR, member);
        }

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
          let result: { success: boolean; error?: string };
          try {
            result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/release`, { nonce });
          } catch {
            result = releaseLock(MEMBERS_DIR, member, nonce);
          }
          if (result.success) {
            unregisterLockNonce(member);
            try {
              await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: `deactivated${note ? ": " + note : ""}` });
            } catch {
              appendWorkLog(MEMBERS_DIR, member, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: `deactivated${note ? ": " + note : ""}` });
            }
          }
        }

        // 清理 MCP 子进程
        await cleanupMemberMcps(member);
        // 删心跳
        try {
          await callPanel("DELETE", `/api/member/${memberEnc}/heartbeat`);
        } catch {
          removeHeartbeat(MEMBERS_DIR, member);
        }
        // 清理残留的 departure.json（防止状态不一致）
        deleteDepartureFile(member);
        // 清内存追踪
        clearMemberTracking(member);

        return ok({ success: true, member, note: note ?? null, hint: "→ 已下线。建议用 send_msg(to=\"leader\", content=\"任务XXX已完成\") 通知 leader 任务进展。" });
      }

      // ── get_status ────────────────────────
      case "get_status": {
        const member = optStr("member");
        if (member) {
          const memberEnc = encodeURIComponent(member);
          let lock: { project: string; task: string } | null;
          try { lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`); } catch { lock = readLock(MEMBERS_DIR, member); }
          const profile = getProfile(MEMBERS_DIR, member);
          let hb: { last_seen_ms: number; last_seen: string } | null;
          try { hb = await callPanel<typeof hb>("GET", `/api/member/${memberEnc}/heartbeat`); } catch { hb = readHeartbeat(MEMBERS_DIR, member); }
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          const depState = readDepartureFile(member);
          const status = depState?.pending ? "pending_departure" : lock && online ? "working" : online ? "online" : "offline";
          return ok({ member, profile, lock, status, online, working: !!lock, last_seen: hb?.last_seen, pending_departure: !!depState?.pending });
        }
        // All members
        let members: Array<{ uid: string; name: string; role: string }>;
        try {
          members = await callPanel<typeof members>("GET", "/api/member/list");
        } catch {
          members = listMembers(MEMBERS_DIR);
        }
        const statuses = [];
        for (const m of members) {
          const mEnc = encodeURIComponent(m.name);
          let lock: { project: string; task: string } | null;
          try { lock = await callPanel<typeof lock>("GET", `/api/member/${mEnc}/lock`); } catch { lock = readLock(MEMBERS_DIR, m.name); }
          let hb: { last_seen_ms: number; last_seen: string } | null;
          try { hb = await callPanel<typeof hb>("GET", `/api/member/${mEnc}/heartbeat`); } catch { hb = readHeartbeat(MEMBERS_DIR, m.name); }
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          const depState = readDepartureFile(m.name);
          const status = depState?.pending ? "pending_departure" : lock && online ? "working" : online ? "online" : "offline";
          statuses.push({ uid: m.uid, member: m.name, role: m.role, status, online, working: !!lock, last_seen: hb?.last_seen, lock, pending_departure: !!depState?.pending });
        }
        return ok(statuses);
      }

      // ── force_release ─────────────────────
      case "force_release": {
        const caller = str("caller");
        const member = str("member");
        checkPrivilege(caller, "force_release");
        let result: { success: boolean; error?: string };
        try {
          result = await callPanel<typeof result>("POST", `/api/member/${encodeURIComponent(member)}/lock/force-release`);
        } catch {
          result = forceRelease(MEMBERS_DIR, member);
        }
        if (result.success) unregisterLockNonce(member);
        return ok({
          ...result,
          ...(result.success ? { hint: "→ 成员已解锁。如需重新分配任务，调 request_member 预约 + spawn Agent" } : {}),
        });
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
        try {
          await callPanel("POST", `/api/member/${encodeURIComponent(member)}/memory/save`, { scope, content, ...(project ? { project } : {}) });
        } catch {
          saveMemory(MEMBERS_DIR, member, scope, content, project);
        }
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
        let content: string;
        try {
          const params = new URLSearchParams();
          if (scope) params.set("scope", scope);
          if (project) params.set("project", project);
          const qs = params.toString();
          const data = await callPanel<{ content: string }>("GET", `/api/member/${encodeURIComponent(member)}/memory${qs ? "?" + qs : ""}`);
          content = data.content;
        } catch {
          content = readMemory(MEMBERS_DIR, member, scope, project);
        }
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
          resp.hint = "→ 与已有经验重复度较高，请确认是否有新增价值，避免噪音积累";
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
        return ok({
          keyword,
          results,
          ...(results.length === 0 ? { hint: "→ 未找到相关经验。可换关键词重试，或直接开工，完成后 submit_experience 贡献经验给团队" } : {}),
        });
      }

      // ── propose_rule ──────────────────────
      case "propose_rule": {
        const member = str("member");
        const rule = str("rule");
        const reason = str("reason");
        const result = proposeRule(SHARED_DIR, member, rule, reason);
        return ok({ ...result, hint: "→ 规则已入队。请用 send_msg(to='leader 名字', content='有新规则待审，请调 review_rules') 通知 leader。如不知道 leader 名字，调 get_roster 查看。" });
      }

      // ── review_rules ──────────────────────
      case "review_rules": {
        const rules = reviewRules(SHARED_DIR);
        const pending = Array.isArray(rules) ? rules : [];
        const hint = pending.length > 0
          ? "→ 逐条 approve_rule(rule_id) 或 reject_rule(rule_id, reason) 处理"
          : "→ 暂无待审规则";
        return ok({ rules, hint });
      }

      // ── approve_rule ──────────────────────
      case "approve_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        checkPrivilege(caller, "approve_rule");
        const result = approveRule(SHARED_DIR, ruleId, caller);
        return ok({ ...result, hint: "→ 继续 review_rules 查看剩余待审规则" });
      }

      // ── reject_rule ───────────────────────
      case "reject_rule": {
        const caller = str("caller");
        const ruleId = str("rule_id");
        const reason = str("reason");
        checkPrivilege(caller, "reject_rule");
        const result = rejectRule(SHARED_DIR, ruleId, reason);

        // 通知提议者规则被拒
        if (result.success && result.proposer) {
          try {
            await callPanel("POST", "/api/message/send", {
              from: caller,
              to: result.proposer,
              content: `[规则审批结果] 你提议的规则「${result.rule}」已被拒绝。原因：${reason}`,
              priority: "normal",
            });
          } catch { /* 通知失败不阻塞主流程 */ }
        }

        return ok({ ...result, hint: "→ 继续 review_rules 查看剩余待审规则" });
      }

      // ── hire_temp ─────────────────────────
      case "hire_temp": {
        const caller = str("caller");
        checkPrivilege(caller, "hire_temp");
        const name = str("name");
        const role = str("role");
        const skills = Array.isArray(a["skills"])
          ? (a["skills"] as string[])
          : [];
        const description = optStr("description");
        const profile: MemberProfile = {
          uid: crypto.randomUUID(),
          name,
          role,
          type: "temporary",
          joined_at: new Date().toISOString(),
          skills,
          description,
        };
        try {
          await callPanel("POST", "/api/member/create", profile);
        } catch {
          saveProfile(MEMBERS_DIR, profile);
        }
        return ok({
          success: true,
          profile,
          hint: `→ 临时成员已创建。下一步：request_member(member='${name}') 预约 → spawn Agent → 成员 activate 开工`,
        });
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

        return ok({
          success: true,
          evaluation: evalEntry,
          hint: convertToPermanent
            ? "→ 已转为正式成员，后续正常 request_member 分配任务"
            : "→ 临时成员未转正，后续不再分配任务即可",
        });
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
        return ok({
          templates,
          ...(templates.length === 0 ? { hint: "→ 暂无模板，直接 hire_temp 创建新成员" } : {}),
        });
      }

      // ── team_report ───────────────────────
      case "team_report": {
        let members: Array<{ uid: string; name: string; role: string }>;
        try {
          members = await callPanel<typeof members>("GET", "/api/member/list");
        } catch {
          members = listMembers(MEMBERS_DIR);
        }
        const working: unknown[] = [];
        const idle: unknown[] = [];
        for (const m of members) {
          let lock: unknown;
          try { lock = await callPanel("GET", `/api/member/${encodeURIComponent(m.name)}/lock`); } catch { lock = readLock(MEMBERS_DIR, m.name); }
          if (lock) {
            working.push({ uid: m.uid, name: m.name, role: m.role, lock });
          } else {
            idle.push({ uid: m.uid, name: m.name, role: m.role });
          }
        }
        return ok({ working, idle, total: members.length, hint: "→ 确认分配是否合理，可用 request_member 调整" });
      }

      // ── project_dashboard ─────────────────
      case "project_dashboard": {
        const project = str("project");
        let members: Array<{ uid: string; name: string }>;
        try {
          members = await callPanel<typeof members>("GET", "/api/member/list");
        } catch {
          members = listMembers(MEMBERS_DIR);
        }
        const result: unknown[] = [];
        for (const m of members) {
          let lock: { project: string; task: string; locked_at: string } | null;
          try { lock = await callPanel<typeof lock>("GET", `/api/member/${encodeURIComponent(m.name)}/lock`); } catch { lock = readLock(MEMBERS_DIR, m.name); }
          if (lock && lock.project === project) {
            result.push({ uid: m.uid, name: m.name, task: lock.task, locked_at: lock.locked_at });
          }
        }
        return ok({ project, members: result, hint: "→ 如需调整成员，可 release_member 释放后重新 request_member" });
      }

      // ── work_history ──────────────────────
      case "work_history": {
        const member = str("member");
        const limit = num("limit", 20);
        let logs: unknown[];
        try {
          const data = await callPanel<{ worklog: unknown[] }>("GET", `/api/member/${encodeURIComponent(member)}/worklog?limit=${limit}`);
          logs = data.worklog ?? [];
        } catch {
          logs = readWorkLog(MEMBERS_DIR, member);
        }
        return ok({ member, history: Array.isArray(logs) ? logs.slice(-limit) : logs });
      }

      // ── stuck_scan ────────────────────────
      case "stuck_scan": {
        const timeoutMinutes = num("timeout_minutes", DEFAULT_STUCK_TIMEOUT_MINUTES);
        const now = Date.now();
        const stuck: unknown[] = [];
        let members: Array<{ name: string }>;
        try {
          members = await callPanel<typeof members>("GET", "/api/member/list");
        } catch {
          members = listMembers(MEMBERS_DIR);
        }
        for (const m of members) {
          let lock: { locked_at: string; project: string; task: string } | null;
          try { lock = await callPanel<typeof lock>("GET", `/api/member/${encodeURIComponent(m.name)}/lock`); } catch { lock = readLock(MEMBERS_DIR, m.name); }
          if (!lock) continue;
          const lockedAt = new Date(lock.locked_at).getTime();
          const elapsed = (now - lockedAt) / 60000;
          if (elapsed > timeoutMinutes) {
            stuck.push({ name: m.name, lock, elapsed_minutes: Math.round(elapsed) });
          }
        }
        return ok({
          stuck,
          timeout_minutes: timeoutMinutes,
          ...(stuck.length > 0
            ? { action_hint: "→ 对每个卡住成员：1. SendMessage 催促确认 2. 无响应则 force_release 释放 3. 重新 request_member 分配任务" }
            : { hint: "团队无卡住成员，运行正常" }),
        });
      }

      // ── handoff ───────────────────────────
      case "handoff": {
        const from = str("from");
        const to = str("to");
        const note = optStr("note");
        const fromEnc = encodeURIComponent(from);
        const toEnc = encodeURIComponent(to);

        let fromLock: { nonce: string; project: string; task: string } | null;
        try { fromLock = await callPanel<typeof fromLock>("GET", `/api/member/${fromEnc}/lock`); } catch { fromLock = readLock(MEMBERS_DIR, from); }
        if (!fromLock) return ok({ success: false, error: `${from} is not checked in` });

        let relResult: { success: boolean; error?: string };
        try { relResult = await callPanel<typeof relResult>("POST", `/api/member/${fromEnc}/lock/release`, { nonce: fromLock.nonce }); } catch { relResult = releaseLock(MEMBERS_DIR, from, fromLock.nonce); }
        if (!relResult.success) return ok(relResult);
        unregisterLockNonce(from);

        try {
          await callPanel("POST", `/api/member/${fromEnc}/worklog`, { event: "check_out", timestamp: new Date().toISOString(), project: fromLock.project, task: fromLock.task, note: `handoff to ${to}: ${note ?? ""}` });
        } catch {
          appendWorkLog(MEMBERS_DIR, from, { event: "check_out", timestamp: new Date().toISOString(), project: fromLock.project, task: fromLock.task, note: `handoff to ${to}: ${note ?? ""}` });
        }

        let acqResult: { success: boolean; error?: string };
        try {
          acqResult = await callPanel<typeof acqResult>("POST", `/api/member/${toEnc}/lock/acquire`, { session_pid: sessionPid, session_start: sessionStart, project: fromLock.project, task: fromLock.task });
        } catch {
          acqResult = acquireLock(MEMBERS_DIR, to, sessionPid, sessionStart, fromLock.project, fromLock.task);
        }
        if (acqResult.success) {
          let toLock: { nonce: string } | null;
          try { toLock = await callPanel<typeof toLock>("GET", `/api/member/${toEnc}/lock`); } catch { toLock = readLock(MEMBERS_DIR, to); }
          if (toLock) registerLockNonce(to, toLock.nonce);
          try {
            await callPanel("POST", `/api/member/${toEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project: fromLock.project, task: fromLock.task, note: `handoff from ${from}: ${note ?? ""}` });
          } catch {
            appendWorkLog(MEMBERS_DIR, to, { event: "check_in", timestamp: new Date().toISOString(), project: fromLock.project, task: fromLock.task, note: `handoff from ${from}: ${note ?? ""}` });
          }
          // 通知接收方
          try {
            await callPanel("POST", "/api/message/send", {
              from,
              to,
              content: `[handoff] ${from} 将任务交接给你。项目: ${fromLock.project}，任务: ${fromLock.task}${note ? "，备注: " + note : ""}。请调用 activate(member="${to}") 加载上下文后继续工作。`,
              priority: "urgent",
            });
          } catch { /* 通知失败不影响交接本身 */ }
        }

        return ok({
          success: acqResult.success,
          from,
          to,
          project: fromLock.project,
          task: fromLock.task,
          ...(acqResult.success ? { hint: `→ 交接完成，已通知 ${to}。接收方需调用 activate（无需 reservation_code，handoff 已转移正式锁）加载上下文后继续工作` } : {}),
        });
      }

      // ── request_member ────────────────────
      case "request_member": {
        const caller = str("caller");
        const member = str("member");
        const project = str("project");
        const task = str("task");
        const autoSpawn = a.auto_spawn === true;
        const cliName = typeof a.cli_name === "string" ? a.cli_name : "claude";
        let workspacePath = optStr("workspace_path");
        const previousMember = optStr("previous_member");

        // 如果没传 workspace_path 且需要 auto_spawn，尝试从 leader 的 PTY session 继承 cwd
        if (!workspacePath && autoSpawn) {
          try {
            const sessionsData = await callPanel<{ sessions: Array<{ memberId: string; status: string; cwd?: string }> }>("GET", "/api/pty/sessions");
            if (sessionsData?.sessions) {
              // 优先找 caller 的 session，其次找任意有 cwd 的 running session
              const callerSession = sessionsData.sessions.find(
                (s) => s.memberId === caller && s.status === "running" && s.cwd
              );
              const anySession = sessionsData.sessions.find(
                (s) => s.status === "running" && s.cwd
              );
              const picked = callerSession ?? anySession;
              if (picked?.cwd) {
                workspacePath = picked.cwd;
                process.stderr.write(`[request_member] inherited workspace_path from ${picked.memberId}: ${workspacePath}\n`);
              }
            }
          } catch {
            // Panel 不可用时静默跳过，不影响后续流程
          }
        }

        // 检查成员是否存在
        const memberEnc = encodeURIComponent(member);
        let profile: MemberProfile | null;
        try {
          profile = await callPanel<MemberProfile | null>("GET", `/api/member/${memberEnc}`);
        } catch {
          profile = getProfile(MEMBERS_DIR, member);
        }
        if (!profile) {
          return ok({ reserved: false, reason: `成员 ${member} 不存在` });
        }

        // 检查是否已有正式锁
        let existingLock: { session_pid: number; nonce: string; project: string; task: string } | null;
        try {
          existingLock = await callPanel<typeof existingLock>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          existingLock = readLock(MEMBERS_DIR, member);
        }
        if (existingLock) {
          // 同 session → 已在本 session 工作
          if (existingLock.session_pid === sessionPid) {
            return ok({
              reserved: false,
              already_active: true,
              reason: `成员 ${member} 已在本 session 工作中（项目: ${existingLock.project}），无需重复预约`,
              member_info: profile,
              hint: `→ 直接用 send_msg(to="${member}", content="新指令") 下达任务即可`,
            });
          }

          // 他人 session → 尝试 takeover（进程可能已死）
          let takeResult: { success: boolean; error?: string };
          try {
            takeResult = await callPanel<typeof takeResult>("POST", `/api/member/${memberEnc}/lock/takeover`, { session_pid: sessionPid, session_start: sessionStart, project, task });
          } catch {
            takeResult = takeover(MEMBERS_DIR, member, sessionPid, sessionStart, project, task);
          }
          if (!takeResult.success) {
            return ok({
              reserved: false,
              reason: `成员正忙。建议：1. get_roster 选其他空闲成员；2. 等对方完成后重试`,
            });
          }
          // takeover 成功 → 正式锁已转移，创建预约让成员 activate 完成注册
          let takenLock: { nonce: string } | null;
          try { takenLock = await callPanel<typeof takenLock>("GET", `/api/member/${memberEnc}/lock`); } catch { takenLock = readLock(MEMBERS_DIR, member); }
          if (takenLock) registerLockNonce(member, takenLock.nonce);
          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: `takeover by ${caller} from pid ${existingLock.session_pid}` });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, { event: "check_in", timestamp: new Date().toISOString(), project, task, note: `takeover by ${caller} from pid ${existingLock.session_pid}` });
          }
          const takeoverCode = crypto.randomUUID();
          const takeoverRes: Reservation = {
            code: takeoverCode,
            member,
            caller,
            project,
            task,
            session_id: session.id,
            created_at: Date.now(),
            ttl_ms: 120_000,
            ...(previousMember ? { previous_member: previousMember } : {}),
          };
          try {
            await callPanel("POST", `/api/member/${memberEnc}/reservation`, takeoverRes);
          } catch {
            writeReservationFile(member, takeoverRes);
          }
          process.stderr.write(`[reservation] takeover reservation for ${member} (code=${takeoverCode.slice(0, 8)})\n`);
          let takeoverSpawnResult: unknown = null;
          if (autoSpawn) {
            try {
              takeoverSpawnResult = await callPanel("POST", "/api/pty/spawn", {
                member,
                cli_name: cliName,
                task,
                reservation_code: takeoverCode,
                ...(workspacePath ? { workspace_path: workspacePath } : {}),
              }, 10000);
            } catch (err) {
              takeoverSpawnResult = { error: `终端创建失败: ${(err as Error).message}` };
            }
          }
          return ok({
            reserved: true,
            reservation_code: takeoverCode,
            ttl_seconds: 120,
            member_brief: {
              name: profile.name,
              role: profile.role,
              description: profile.description ?? "",
            },
            ...(takeoverSpawnResult ? { spawn_result: takeoverSpawnResult } : {}),
            usage_hint: [
              `预约码: ${takeoverCode}`,
              `→ 终端已创建，用 send_msg(to="${member}", content="任务描述") 给成员下达指令`,
              `→ 取消: 调 cancel_reservation(reservation_code="${takeoverCode}") 释放成员`,
            ].join("\n"),
          });
        }

        // 检查是否已有未过期预约
        let existingRes: Reservation | null;
        try {
          existingRes = await callPanel<Reservation | null>("GET", `/api/member/${memberEnc}/reservation`);
        } catch {
          existingRes = readReservationFile(member);
        }
        if (existingRes && (Date.now() - existingRes.created_at) < existingRes.ttl_ms) {
          return ok({
            reserved: false,
            reason: `成员 ${member} 已有未过期预约（由 ${existingRes.caller} 创建），请稍候重试`,
            hint: "→ 建议重新调 get_roster 确认成员状态后重试",
          });
        }

        // 创建新预约（不获取正式锁）
        const reservationCode = crypto.randomUUID();
        const reservation: Reservation = {
          code: reservationCode,
          member,
          caller,
          project,
          task,
          session_id: session.id,
          created_at: Date.now(),
          ttl_ms: 210_000,
          ...(previousMember ? { previous_member: previousMember } : {}),
        };
        try {
          await callPanel("POST", `/api/member/${memberEnc}/reservation`, reservation);
        } catch {
          writeReservationFile(member, reservation);
        }
        process.stderr.write(`[reservation] created for ${member} by ${caller} (code=${reservationCode.slice(0, 8)})\n`);

        let spawnResult: unknown = null;
        if (autoSpawn) {
          try {
            spawnResult = await callPanel("POST", "/api/pty/spawn", {
              member,
              cli_name: cliName,
              task,
              reservation_code: reservationCode,
              ...(workspacePath ? { workspace_path: workspacePath } : {}),
            }, 10000);
          } catch (err) {
            spawnResult = { error: `终端创建失败: ${(err as Error).message}` };
          }
        }

        return ok({
          reserved: true,
          reservation_code: reservationCode,
          ttl_seconds: 210,
          member_brief: {
            name: profile.name,
            role: profile.role,
            description: profile.description ?? "",
          },
          ...(spawnResult ? { spawn_result: spawnResult } : {}),
          usage_hint: [
            `预约码: ${reservationCode}`,
            `→ 终端已创建，用 send_msg(to="${member}", content="任务描述") 给成员下达指令`,
            `→ 取消: 调 cancel_reservation(reservation_code="${reservationCode}") 释放成员`,
          ].join("\n"),
        });
      }

      // ── cancel_reservation ───────────────
      case "cancel_reservation": {
        const code = str("reservation_code");
        // 扫描所有成员找到匹配预约码的 reservation
        let memberNames: string[];
        try {
          const members = await callPanel<Array<{ name: string }>>("GET", "/api/member/list");
          memberNames = members.map(m => m.name);
        } catch {
          memberNames = fs.readdirSync(MEMBERS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
        }
        for (const name of memberNames) {
          let res: Reservation | null;
          try { res = await callPanel<Reservation | null>("GET", `/api/member/${encodeURIComponent(name)}/reservation`); } catch { res = readReservationFile(name); }
          if (res && res.code === code) {
            try { await callPanel("DELETE", `/api/member/${encodeURIComponent(name)}/reservation`); } catch { deleteReservationFile(name); }
            process.stderr.write(`[reservation] cancelled for ${name} by code\n`);
            return ok({ cancelled: true, member: name });
          }
        }
        return ok({ cancelled: false, reason: "未找到匹配的预约码，可能已过期或已被使用" });
      }

      // ── activate ──────────────────────────
      case "activate": {
        const member = str("member");
        const reservationCodeArg = optStr("reservation_code");
        const memberEnc = encodeURIComponent(member);
        let predecessorMember: string | undefined;

        let activeLock: { nonce: string; project: string; task: string } | null;
        try {
          activeLock = await callPanel<typeof activeLock>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          activeLock = readLock(MEMBERS_DIR, member);
        }

        if (reservationCodeArg) {
          // 有预约码 → 验证预约并转正式锁
          let res: Reservation | null;
          try { res = await callPanel<Reservation | null>("GET", `/api/member/${memberEnc}/reservation`); } catch { res = readReservationFile(member); }
          if (!res) {
            return ok({ error: `成员 ${member} 没有待验证的预约，请先通过 request_member 申请` });
          }
          if (res.code !== reservationCodeArg) {
            return ok({ error: "预约码不匹配，请检查 reservation_code 参数" });
          }
          if (Date.now() - res.created_at > res.ttl_ms) {
            try { await callPanel("DELETE", `/api/member/${memberEnc}/reservation`); } catch { deleteReservationFile(member); }
            return ok({ error: "预约已过期。请通知 leader 重新为你申请（leader 调 request_member）" });
          }

          // 记录前任成员（交接场景）
          if (res.previous_member) {
            predecessorMember = res.previous_member;
          }

          // 预约验证通过 → 删除预约 → 创建/复用正式锁
          try { await callPanel("DELETE", `/api/member/${memberEnc}/reservation`); } catch { deleteReservationFile(member); }

          if (!activeLock) {
            // 无正式锁（正常新预约流程）→ 创建锁
            let acqResult: { success: boolean; error?: string };
            try {
              acqResult = await callPanel<typeof acqResult>("POST", `/api/member/${memberEnc}/lock/acquire`, { session_pid: sessionPid, session_start: sessionStart, project: res.project, task: res.task });
            } catch {
              acqResult = acquireLock(MEMBERS_DIR, member, sessionPid, sessionStart, res.project, res.task);
            }
            if (!acqResult.success) {
              return ok({ error: `无法获取工作锁：${acqResult.error}` });
            }
            try {
              activeLock = await callPanel<typeof activeLock>("GET", `/api/member/${memberEnc}/lock`);
            } catch {
              activeLock = readLock(MEMBERS_DIR, member);
            }
            if (activeLock) {
              registerLockNonce(member, activeLock.nonce);
              try {
                await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_in", timestamp: new Date().toISOString(), project: res.project, task: res.task, note: `activated by reservation (caller=${res.caller})` });
              } catch {
                appendWorkLog(MEMBERS_DIR, member, { event: "check_in", timestamp: new Date().toISOString(), project: res.project, task: res.task, note: `activated by reservation (caller=${res.caller})` });
              }
            }
          } else {
            // 已有正式锁（takeover 流程）→ 直接注册 nonce
            registerLockNonce(member, activeLock.nonce);
          }
        } else {
          // 无预约码 → 向后兼容：检查是否已有正式锁
          if (!activeLock) {
            return ok({ error: "需要预约码或已有工作锁。请先通过 request_member 申请并传入 reservation_code。" });
          }
          // 已有正式锁 → 正常激活（老流程兼容，含 handoff 场景）
          registerLockNonce(member, activeLock.nonce);
          // 检测 handoff 场景：最近一条 worklog 含 "handoff from" 说明有前任
          try {
            const logs = readWorkLog(MEMBERS_DIR, member);
            if (logs.length > 0) {
              const last = logs[logs.length - 1];
              const handoffMatch = typeof last.note === "string" && last.note.match(/handoff from (\S+)/);
              if (handoffMatch) {
                predecessorMember = handoffMatch[1].replace(/:$/, "");
              }
            }
          } catch { /* worklog 读取失败不影响激活 */ }
        }

        if (!activeLock) {
          return ok({ error: "激活失败：无法获取工作锁" });
        }

        markActivated(member);
        registerLockNonce(member, activeLock.nonce);
        try {
          await callPanel("POST", `/api/member/${memberEnc}/heartbeat`, { session_pid: sessionPid, last_tool: "activate" });
        } catch {
          touchHeartbeat(MEMBERS_DIR, member, sessionPid, "activate");
        }

        // ── 基础信息 ──
        let profile: MemberProfile | null;
        try { profile = await callPanel<MemberProfile | null>("GET", `/api/member/${memberEnc}`); } catch { profile = getProfile(MEMBERS_DIR, member); }
        let persona: string;
        try {
          const data = await callPanel<{ persona: string }>("GET", `/api/member/${memberEnc}/persona`);
          persona = data.persona ?? "";
        } catch {
          const personaPath = path.join(MEMBERS_DIR, member, "persona.md");
          persona = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, "utf-8") : "";
        }

        let memory_generic: string;
        try {
          const d = await callPanel<{ content: string }>("GET", `/api/member/${memberEnc}/memory?scope=generic`);
          memory_generic = d.content;
        } catch {
          memory_generic = readMemory(MEMBERS_DIR, member, "generic");
        }
        let memory_project: string;
        try {
          const d = await callPanel<{ content: string }>("GET", `/api/member/${memberEnc}/memory?scope=project&project=${encodeURIComponent(activeLock.project)}`);
          memory_project = d.content;
        } catch {
          memory_project = readMemory(MEMBERS_DIR, member, "project", activeLock.project);
        }
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
          (p) => p.name === activeLock.project || p.members.includes(member)
        );
        if (currentProject) {
          project_rules = { forbidden: currentProject.forbidden, rules: currentProject.rules };
          project_members = currentProject.members.filter((m) => m !== member);
        }

        // 获取待处理消息数量（不消费）
        let pending_messages_count = 0;
        try {
          const inboxData = await callPanel<{ messages?: unknown[] }>("GET", `/api/message/inbox/${memberEnc}`);
          pending_messages_count = inboxData?.messages?.length ?? 0;
        } catch { /* Panel 不可用时忽略 */ }

        // 构建动态编号的 workflow 步骤
        let stepNum = 1;
        const workflowSteps: string[] = ["→ 你已激活。执行顺序："];
        workflowSteps.push(`${stepNum++}. 阅读上面的 persona（你的角色定义）和 team_rules（团队规则）`);
        workflowSteps.push(peer_pair
          ? `${stepNum++}. 你的审计对象是 ${peer_pair.partner}（${peer_pair.relationship}），完成后找对方 review`
          : `${stepNum++}. 无指定审计对象`);
        workflowSteps.push(project_rules
          ? `${stepNum++}. 注意 project_rules 中的 forbidden（绝对禁止）和 rules（必须遵守）`
          : `${stepNum++}. 当前项目无特殊规则`);
        workflowSteps.push(`${stepNum++}. 调 search_experience(keyword) 搜索相关经验，避免重复踩坑`);
        if (predecessorMember) {
          workflowSteps.push(`${stepNum++}. 你是接替 ${predecessorMember} 的任务，调 work_history(member="${predecessorMember}") 和 read_memory(member="${predecessorMember}") 了解前任进度`);
        }
        if (pending_messages_count > 0) {
          workflowSteps.push(`${stepNum++}. 你有 ${pending_messages_count} 条待读消息，先调 check_inbox(member=你自己, peek=true) 查看`);
        }
        workflowSteps.push(`${stepNum++}. 开始执行任务`);
        workflowSteps.push(`${stepNum++}. 每完成一个子任务后调 checkpoint(member=你自己) 自查：是否偏离目标、有无遗漏`);
        workflowSteps.push(`${stepNum++}. 全部完成后：save_memory → deactivate(member=你自己)`);

        return ok({
          identity: {
            uid: profile?.uid ?? member,
            name: profile?.name ?? member,
            role: profile?.role ?? "unknown",
          },
          persona,
          memory_generic,
          memory_project,
          current_task: { project: activeLock.project, task: activeLock.task },
          team_rules,
          peer_pair,
          project_rules,
          project_members,
          ...(predecessorMember ? { predecessor: predecessorMember } : {}),
          pending_messages_count,
          workflow_hint: workflowSteps.join("\n"),
        });
      }

      // ── release_member ────────────────────
      case "release_member": {
        const caller = str("caller");
        const member = str("member");
        const memberEnc = encodeURIComponent(member);
        checkPrivilege(caller, "release_member");

        let lock: { nonce: string; project: string; task: string } | null;
        try { lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`); } catch { lock = readLock(MEMBERS_DIR, member); }
        if (!lock) {
          return ok({ success: false, error: "成员未持锁" });
        }

        let result: { success: boolean; error?: string };
        try { result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/release`, { nonce: lock.nonce }); } catch { result = releaseLock(MEMBERS_DIR, member, lock.nonce); }
        if (result.success) {
          unregisterLockNonce(member);
          clearMemberTracking(member);
          try { await callPanel("DELETE", `/api/member/${memberEnc}/heartbeat`); } catch { removeHeartbeat(MEMBERS_DIR, member); }
          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: `released by ${caller}` });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, { event: "check_out", timestamp: new Date().toISOString(), project: lock.project, task: lock.task, note: `released by ${caller}` });
          }
        }
        return ok({
          ...result,
          ...(result.success ? { hint: "→ 成员已释放，如需重新分配可 request_member" } : {}),
        });
      }

      // ── get_roster ────────────────────────
      case "get_roster": {
        let members: Array<{ uid: string; name: string; role: string; type: string; description?: string }>;
        try {
          members = await callPanel<typeof members>("GET", "/api/member/list");
        } catch {
          members = listMembers(MEMBERS_DIR) as typeof members;
        }
        const roster = [];
        for (const m of members) {
          const mEnc = encodeURIComponent(m.name);
          let lock: { project: string; task: string } | null;
          try { lock = await callPanel<typeof lock>("GET", `/api/member/${mEnc}/lock`); } catch { lock = readLock(MEMBERS_DIR, m.name); }
          let hb: { last_seen_ms: number; last_seen: string } | null;
          try { hb = await callPanel<typeof hb>("GET", `/api/member/${mEnc}/heartbeat`); } catch { hb = readHeartbeat(MEMBERS_DIR, m.name); }
          const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
          let reservation: Reservation | null;
          try { reservation = await callPanel<Reservation | null>("GET", `/api/member/${mEnc}/reservation`); } catch { reservation = readReservationFile(m.name); }
          const hasReservation = reservation !== null && (Date.now() - reservation.created_at) < reservation.ttl_ms;
          const departureState = readDepartureFile(m.name);
          let memberStatus: string;
          if (departureState?.pending) {
            memberStatus = "pending_departure";
          } else if (lock) {
            memberStatus = "working";
          } else if (hasReservation) {
            memberStatus = "reserved";
          } else if (online) {
            memberStatus = "online";
          } else {
            memberStatus = "offline";
          }
          roster.push({
            uid: m.uid,
            name: m.name,
            role: m.role,
            type: m.type,
            description: (m as any).description ?? "",
            status: memberStatus,
            current_project: lock?.project ?? null,
            current_task: lock?.task ?? null,
            last_seen: hb?.last_seen ?? null,
          });
        }

        // 读取治理数据
        const govPath = path.join(SHARED_DIR, "governance.json");
        let governance: unknown = null;
        try {
          governance = JSON.parse(fs.readFileSync(govPath, "utf-8"));
        } catch {
          governance = { error: "governance.json not found" };
        }

        // 汇总信息，引导 leader
        const workingCount = roster.filter((r) => r.status === "working").length;
        const reservedCount = roster.filter((r) => r.status === "reserved").length;
        const onlineCount = roster.filter((r) => r.status === "online").length;
        const offlineCount = roster.filter((r) => r.status === "offline").length;
        // working 和 reserved 都算不可分配
        const unavailableStatuses = new Set(["working", "reserved"]);
        const roleSet = new Set(roster.filter((r) => !unavailableStatuses.has(r.status)).map((r) => r.role));
        const busyRoles = new Set(roster.filter((r) => unavailableStatuses.has(r.status)).map((r) => r.role));
        const unavailableRoles = [...busyRoles].filter((r) => !roleSet.has(r));

        const hints: string[] = [];
        if (offlineCount > 0) hints.push(`${offlineCount} 人离线可调用`);
        if (workingCount > 0) hints.push(`${workingCount} 人工作中`);
        if (reservedCount > 0) hints.push(`${reservedCount} 人已预约待激活`);
        if (unavailableRoles.length > 0) hints.push(`角色全忙: ${unavailableRoles.join("、")}，如需可 hire_temp 临时招聘`);
        if (workingCount + reservedCount === roster.length) hints.push("⚠️ 全员忙碌，建议告知用户等待或扩编");
        hints.push("⚠️ 成员状态实时变化，分配任务前应重新查询");

        return ok({
          roster,
          governance,
          summary: {
            total: roster.length,
            working: workingCount,
            reserved: reservedCount,
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
        const toolName2 = str("tool_name");
        const toolArgs = (a["arguments"] ?? {}) as Record<string, unknown>;

        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在。请通过 get_roster 查看成员 uid。`);

        const result = await proxyToolCall(MEMBERS_DIR, memberName, mcpName, toolName2, toolArgs);
        return ok(result);
      }

      case "list_member_mcps": {
        const uid = str("uid");
        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在。请通过 get_roster 查看成员 uid。`);

        // 最新商店列表
        const store = loadStore();
        // 成员已挂载列表
        const mounted = loadMemberMcps(MEMBERS_DIR, memberName);
        const mountedNames = new Set(mounted.map((m) => m.name));

        // 合并：商店全量 + 挂载/运行状态 + 已挂载的子工具详情
        const result = [];
        for (const item of store) {
          const isMounted = mountedNames.has(item.name);
          const running = isMounted && isChildRunning(memberName, item.name);
          let tools: ToolInfo[] = [];
          if (isMounted && running) {
            try {
              tools = await listChildToolDetails(MEMBERS_DIR, memberName, item.name);
            } catch { /* ignore */ }
          }
          result.push({
            name: item.name,
            description: item.description,
            command: item.command,
            mounted: isMounted,
            running,
            tools,
          });
        }

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

        // 只清理被卸载的那一个 MCP 子进程（而非全部）
        const configs = loadMemberMcps(MEMBERS_DIR, member);
        const hasIt = configs.some((c) => c.name === mcpName);
        if (hasIt) {
          await cleanupOneMcp(member, mcpName);
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
        if (!memberName) throw new Error(`UID ${uid} 不存在。请通过 get_roster 查看成员 uid。`);

        const result = mountMcp(MEMBERS_DIR, memberName, mcpName);
        if (!result.success) return ok({ ...result, member: memberName, mcp_name: mcpName });

        // 成员已激活 → 立刻启动子 MCP 进程
        let preSpawned = false;
        let spawnedTools: ToolInfo[] = [];
        if (isActivated(memberName)) {
          try {
            spawnedTools = await preSpawnMcp(MEMBERS_DIR, memberName, mcpName);
            preSpawned = true;
          } catch {
            // spawn 失败不影响挂载配置，下次调用时重试
          }
        }

        return ok({
          ...result,
          member: memberName,
          mcp_name: mcpName,
          pre_spawned: preSpawned,
          tools: spawnedTools,
        });
      }

      case "unmount_mcp": {
        const uid = str("uid");
        const mcpName = str("mcp_name");
        const memberName = findMemberByUid(uid);
        if (!memberName) throw new Error(`UID ${uid} 不存在。请通过 get_roster 查看成员 uid。`);

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

        let lock: { project: string; task: string } | null;
        try { lock = await callPanel<typeof lock>("GET", `/api/member/${encodeURIComponent(member)}/lock`); } catch { lock = readLock(MEMBERS_DIR, member); }
        if (!lock) {
          return ok({ error: "成员无工作锁，无法获取任务信息" });
        }

        const originalTask = { project: lock.project, task: lock.task };

        const allProjects = listAllProjects();
        const currentProject = allProjects.find(
          (p) => p.name === lock.project || p.members.includes(member)
        );
        const projectRules = currentProject
          ? { forbidden: currentProject.forbidden, rules: currentProject.rules }
          : null;

        let acceptanceChain: unknown = null;
        let acceptanceRule: string = "";
        try {
          const gov = loadGovernance();
          acceptanceChain = (gov as any).acceptance_chain ?? null;
          acceptanceRule = (gov as any).acceptance_rule ?? "";
        } catch { /* ignore */ }

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
        return ok({
          ...project,
          hint: `→ 项目已创建。建议立即调 add_project_rule 设置 forbidden（禁止事项）和 rules（必须遵循的规则）`,
        });
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

        const confirmOverwrite = bool("confirm_overwrite", false);

        // 数组缩短保护：新数组比旧数组短时需要 confirm_overwrite=true
        if (!confirmOverwrite) {
          const shrunk: string[] = [];
          for (const field of ["members", "forbidden", "rules"] as const) {
            if (Array.isArray(a[field]) && (a[field] as string[]).length < project[field].length) {
              shrunk.push(`${field}: ${project[field].length} → ${(a[field] as string[]).length}`);
            }
          }
          if (shrunk.length > 0) {
            return ok({
              error: `数组字段将缩短（${shrunk.join(", ")}），可能导致数据丢失。如确认覆盖请传 confirm_overwrite=true`,
              current: { members: project.members, forbidden: project.forbidden, rules: project.rules },
            });
          }
        }

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

      // ── scan_agent_clis ───────────────────────
      case "scan_agent_clis": {
        try {
          const data = await callPanel("GET", "/api/agent-clis");
          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── spawn_pty_session ─────────────────────
      case "spawn_pty_session": {
        const member = str("member");
        const cliName = str("cli_name");
        const cliBin = optStr("cli_bin");
        try {
          const data = await callPanel("POST", "/api/pty/spawn", {
            member,
            cli_name: cliName,
            ...(cliBin ? { cli_bin: cliBin } : {}),
          });
          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── list_pty_sessions ─────────────────────
      case "list_pty_sessions": {
        try {
          const data = await callPanel("GET", "/api/pty/sessions");
          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── kill_pty_session ──────────────────────
      case "kill_pty_session": {
        const sessionId = str("session_id");
        try {
          const data = await callPanel("POST", "/api/pty/kill", { session_id: sessionId });
          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── send_msg ──────────────────────────────
      case "send_msg": {
        const to = str("to");
        const content = str("content");
        const priority = optStr("priority");

        // 推断发送方：优先从 activatedMembers 取，
        // 否则回退到 session 注册时的 memberName，
        // leader session 的 memberName 为空，需特殊处理
        let from = "unknown";
        if (session.activatedMembers.size > 0) {
          from = session.activatedMembers.values().next().value as string;
        } else if (session.memberName) {
          from = session.memberName;
        } else if (session.isLeader) {
          from = "leader";
        }

        // 名字解析统一由 Panel 端完成，Hub 端直接透传 to 参数
        try {
          const data = await callPanel("POST", "/api/message/send", {
            from,
            to,
            content,
            priority: priority ?? "normal",
          });

          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── check_inbox ───────────────────────────
      case "check_inbox": {
        const member = str("member");
        const peek = bool("peek", false);
        try {
          // peek=true 时用 GET 只读不消费；默认用 DELETE 消费（读后清空队列）
          const method = peek ? "GET" : "DELETE";
          const data = await callPanel(method, `/api/message/inbox/${encodeURIComponent(member)}`);
          return ok(data);
        } catch (err) {
          return ok({ error: `Panel 通信失败: ${(err as Error).message}` });
        }
      }

      // ── request_departure ────────────────────────
      case "request_departure": {
        const member = str("member");
        const pending = bool("pending", true);
        const requirement = optStr("requirement");
        const memberEnc = encodeURIComponent(member);

        // 权限校验：只有 leader 能调用
        if (!session.isLeader) {
          return ok({ error: "只有 leader 才能发起离场请求，你不能擅自让成员离场" });
        }

        // 检查成员是否存在
        let profile: MemberProfile | null;
        try {
          profile = await callPanel<MemberProfile | null>("GET", `/api/member/${memberEnc}`);
        } catch {
          profile = getProfile(MEMBERS_DIR, member);
        }
        if (!profile) {
          return ok({ error: `成员 ${member} 不存在` });
        }

        // 检查成员是否 online（有心跳）
        let hb: { last_seen_ms: number; last_seen: string } | null;
        try {
          hb = await callPanel<typeof hb>("GET", `/api/member/${memberEnc}/heartbeat`);
        } catch {
          hb = readHeartbeat(MEMBERS_DIR, member);
        }
        const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
        if (!online) {
          return ok({ error: `成员 ${member} 当前 offline，无法发起离场请求` });
        }

        if (pending) {
          // 发起离场请求
          const departure: DepartureState = {
            pending: true,
            requirement: requirement ?? undefined,
            requested_at: new Date().toISOString(),
            previous_status: "working",
          };
          writeDepartureFile(member, departure);

          // 构建通知消息
          let msgContent = `[离场通知] leader 要求你离场。`;
          if (requirement) {
            msgContent += `\n离场要求：${requirement}`;
          }
          msgContent += `\n\n行为指引：`;
          msgContent += `\n- 如果你不同意，请用 send_msg 回复 leader 简短原因`;
          msgContent += `\n- 如果你同意但需要收尾，请先用 send_msg 告知 leader 你需要收尾，完成后再调 clock_out`;
          msgContent += `\n- 如果你直接同意，收尾后调 clock_out(member=你自己) 下班`;

          // 通过 send_msg 机制通知成员
          try {
            await callPanel("POST", "/api/message/send", {
              from: "leader",
              to: member,
              content: msgContent,
              priority: "urgent",
            });
          } catch {
            // Panel 不可用时静默
          }

          // 记录 worklog
          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, {
              event: "request_departure",
              timestamp: new Date().toISOString(),
              project: "",
              note: requirement ? `requirement: ${requirement}` : "leader requested departure",
            });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, {
              event: "request_departure",
              timestamp: new Date().toISOString(),
              project: "",
              note: requirement ? `requirement: ${requirement}` : "leader requested departure",
            });
          }

          return ok({
            success: true,
            member,
            status: "pending_departure",
            hint: "这是异步状态标记。已通过 PTY 通知成员，成员会自行处理收尾后调 clock_out 下班。你无需等待，可继续其他工作。",
          });
        } else {
          // 撤销离场请求
          const departure = readDepartureFile(member);
          if (!departure || !departure.pending) {
            return ok({ error: `成员 ${member} 当前没有待离场请求` });
          }

          deleteDepartureFile(member);

          // 通知成员撤销
          try {
            await callPanel("POST", "/api/message/send", {
              from: "leader",
              to: member,
              content: "[离场撤销] leader 已撤回离场请求，你可以继续工作。",
              priority: "normal",
            });
          } catch {
            // Panel 不可用时静默
          }

          // 记录 worklog
          try {
            await callPanel("POST", `/api/member/${memberEnc}/worklog`, {
              event: "cancel_departure",
              timestamp: new Date().toISOString(),
              project: "",
              note: "leader cancelled departure request",
            });
          } catch {
            appendWorkLog(MEMBERS_DIR, member, {
              event: "cancel_departure",
              timestamp: new Date().toISOString(),
              project: "",
              note: "leader cancelled departure request",
            });
          }

          return ok({
            success: true,
            member,
            status: "working",
            hint: "已撤销离场请求，成员恢复工作状态。",
          });
        }
      }

      // ── clock_out ─────────────────────────────────
      case "clock_out": {
        const member = str("member");
        const note = optStr("note");
        const force = bool("force", false);
        const memberEnc = encodeURIComponent(member);

        // 权限校验：leader 不能调用
        if (session.isLeader) {
          return ok({ error: "leader 由用户控制，不能自行下班" });
        }

        // 身份校验：只能给自己下班
        if (session.memberName !== member) {
          return ok({ error: "你只能为自己下班" });
        }

        // 检查 pending_departure 状态
        const departure = readDepartureFile(member);
        if (!departure || !departure.pending) {
          // 区分是否曾被撤销
          if (departure && !departure.pending) {
            return ok({ error: "leader 已撤回离场请求" });
          }
          return ok({ error: "你未被 leader 批准离场。如需正常下线请用 deactivate。" });
        }

        // 经验保存检查（与 deactivate 一致）
        if (isActivated(member) && !hasMemorySaved(member) && !force) {
          return ok({
            success: false,
            error: "请先调用 save_memory 保存本次工作经验，再 clock_out。如确实无经验可存，传 force=true 跳过。",
          });
        }

        // ── 执行下班流程（参考 deactivate 逻辑）──

        // 1. 释放工作锁
        let lock: { nonce: string; project: string; task: string } | null;
        try {
          lock = await callPanel<typeof lock>("GET", `/api/member/${memberEnc}/lock`);
        } catch {
          lock = readLock(MEMBERS_DIR, member);
        }
        if (lock) {
          const nonce = getLockNonce(member) ?? lock.nonce;
          let result: { success: boolean; error?: string };
          try {
            result = await callPanel<typeof result>("POST", `/api/member/${memberEnc}/lock/release`, { nonce });
          } catch {
            result = releaseLock(MEMBERS_DIR, member, nonce);
          }
          if (result.success) {
            unregisterLockNonce(member);
          }
        }

        // 2. 清理 MCP 子进程
        await cleanupMemberMcps(member);

        // 3. 删除心跳
        try {
          await callPanel("DELETE", `/api/member/${memberEnc}/heartbeat`);
        } catch {
          removeHeartbeat(MEMBERS_DIR, member);
        }

        // 4. 清内存追踪
        clearMemberTracking(member);

        // 5. 记录 worklog
        try {
          await callPanel("POST", `/api/member/${memberEnc}/worklog`, {
            event: "clock_out",
            timestamp: new Date().toISOString(),
            project: lock?.project ?? "",
            task: lock?.task ?? "",
            note: note ? `clock_out: ${note}` : "clock_out",
          });
        } catch {
          appendWorkLog(MEMBERS_DIR, member, {
            event: "clock_out",
            timestamp: new Date().toISOString(),
            project: lock?.project ?? "",
            task: lock?.task ?? "",
            note: note ? `clock_out: ${note}` : "clock_out",
          });
        }

        // 6. 通知 leader
        try {
          await callPanel("POST", "/api/message/send", {
            from: member,
            to: "leader",
            content: `[下班通知] ${member} 已完成收尾并下班。${note ? "备注：" + note : ""}`,
            priority: "normal",
          });
        } catch {
          // Panel 不可用时静默
        }

        // 7. 清理 departure 状态文件
        deleteDepartureFile(member);

        // 8. 关闭终端窗口（kill PTY）
        try {
          const sessionsData = await callPanel<{ sessions: Array<{ session_id: string; memberId: string; status: string }> }>("GET", "/api/pty/sessions");
          if (sessionsData?.sessions) {
            const memberSession = sessionsData.sessions.find(
              (s) => s.memberId === member && s.status === "running"
            );
            if (memberSession) {
              await callPanel("POST", "/api/pty/kill", { session_id: memberSession.session_id });
            }
          }
        } catch {
          // Panel 不可用时静默，终端窗口会因进程退出自然关闭
        }

        return ok({
          success: true,
          member,
          status: "offline",
          hint: "已完成下班流程：释放锁、清理 MCP、删除心跳、关闭终端、通知 leader。",
        });
      }

      // ── list_api_keys ─────────────────────────
      case "list_api_keys": {
        try {
          const data = await callPanel<{ keys: string[] }>("GET", "/api/vault/list");
          return ok(data);
        } catch (err) {
          return ok({ error: `list_api_keys 失败: ${(err as Error).message}` });
        }
      }

      // ── use_api ─────────────────────────────────
      case "use_api": {
        const api_name = str("api_name");
        const url = str("url");
        const method = optStr("method") ?? "POST";
        const headers = a["headers"] as Record<string, string> | undefined;
        const body = a["body"];

        try {
          const data = await callPanel("POST", "/api/vault/proxy", {
            session_id: session.id,
            api_name,
            url,
            method,
            headers,
            body,
          }, 30000); // 30s timeout for API proxy calls

          return ok(data);
        } catch (err) {
          return ok({ error: `use_api 失败: ${(err as Error).message}` });
        }
      }

      // ── ask_user ──────────────────────────────
      case "ask_user": {
        const type = str("type");
        const title = str("title");
        const question = str("question");
        const options = a["options"] as string[] | undefined;
        const timeout_ms = num("timeout_ms", 120000);

        // 参数校验：single_choice / multi_choice 必须有 options
        if ((type === "single_choice" || type === "multi_choice") && (!Array.isArray(options) || options.length === 0)) {
          return ok({ error: `type=${type} 需要提供非空 options 数组` });
        }

        // 推断发起者
        let member_name = "unknown";
        if (session.activatedMembers.size > 0) {
          member_name = session.activatedMembers.values().next().value as string;
        } else if (session.memberName) {
          member_name = session.memberName;
        } else if (session.isLeader) {
          member_name = "leader";
        }

        try {
          // 同步等待 Panel 端弹窗回答（Panel 控制超时）
          const data = await callPanel("POST", "/api/ask-user", {
            member_name,
            type,
            title,
            question,
            options,
            timeout_ms,
          }, timeout_ms + 5000); // HTTP 超时比弹窗超时多 5s 余量

          return ok(data);
        } catch (err) {
          return ok({ error: `ask_user 失败: ${(err as Error).message}` });
        }
      }

      default:
        throw new Error(`unknown tool: ${toolName}`);
    }
  } catch (err) {
    const e = err as Error;
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
}

// ──────────────────────────────────────────────
// HTTP 路由处理
// ──────────────────────────────────────────────
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const startTime = Date.now();

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    // GET /api/health
    if (method === "GET" && url === "/api/health") {
      return jsonResponse(res, 200, {
        ok: true,
        sessions: sessions.size,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    }

    // GET /api/tools
    if (method === "GET" && url === "/api/tools") {
      return jsonResponse(res, 200, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    // GET /api/status — panel 用，返回全员状态
    if (method === "GET" && url === "/api/status") {
      const members = listMembers(MEMBERS_DIR);
      const statuses = members.map((m) => {
        const lock = readLock(MEMBERS_DIR, m.name);
        const hb = readHeartbeat(MEMBERS_DIR, m.name);
        const online = hb !== null && (Date.now() - hb.last_seen_ms) < HEARTBEAT_TIMEOUT_MS;
        const depState = readDepartureFile(m.name);
        const status = depState?.pending ? "pending_departure" : lock && online ? "working" : online ? "online" : "offline";
        return {
          uid: m.uid,
          name: m.name,
          role: m.role,
          type: m.type,
          status,
          online,
          working: !!lock,
          last_seen: hb?.last_seen ?? null,
          lock,
          pending_departure: !!depState?.pending,
        };
      });
      return jsonResponse(res, 200, {
        members: statuses,
        sessions: sessions.size,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    }

    // POST /api/session/register
    if (method === "POST" && url === "/api/session/register") {
      const body = await readBody(req) as { pid?: number; lstart?: string; member?: string; isLeader?: boolean };
      if (typeof body.pid !== "number" || typeof body.lstart !== "string") {
        return jsonResponse(res, 400, { error: "missing pid or lstart" });
      }
      const sessionId = registerSession(body.pid, body.lstart, body.member || "", !!body.isLeader);
      return jsonResponse(res, 200, { session_id: sessionId });
    }

    // POST /api/session/unregister
    if (method === "POST" && url === "/api/session/unregister") {
      const body = await readBody(req) as { session_id?: string };
      if (typeof body.session_id !== "string") {
        return jsonResponse(res, 400, { error: "missing session_id" });
      }
      await unregisterSession(body.session_id);
      return jsonResponse(res, 200, { ok: true });
    }

    // POST /api/call
    if (method === "POST" && url === "/api/call") {
      const body = await readBody(req) as {
        session_id?: string;
        tool?: string;
        arguments?: Record<string, unknown>;
      };

      if (typeof body.session_id !== "string") {
        return jsonResponse(res, 400, { error: "missing session_id" });
      }
      if (typeof body.tool !== "string") {
        return jsonResponse(res, 400, { error: "missing tool" });
      }

      const session = sessions.get(body.session_id);
      if (!session) {
        return jsonResponse(res, 404, { error: `session ${body.session_id} not found` });
      }

      touchSession(body.session_id);
      process.stderr.write(`[hub] call: ${body.tool} (session=${body.session_id.slice(0, 8)})\n`);

      const result = await handleToolCall(session, body.tool, body.arguments ?? {});
      return jsonResponse(res, 200, result);
    }

    return jsonResponse(res, 404, { error: "not found" });
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`[hub] request error: ${e.message}\n`);
    return jsonResponse(res, 500, { error: e.message });
  }
});

// ──────────────────────────────────────────────
// 心跳巡检（60s）
// ──────────────────────────────────────────────
const HEARTBEAT_SWEEP_INTERVAL_MS = 60_000;

setInterval(async () => {
  // ⚠️ 心跳巡检：kill -9 / crash / 断电等异常退出不会触发正常清理流程，
  // 所以这里必须双重检查：
  // 1. 心跳超时（> 3 分钟未更新）
  // 2. 心跳对应的 PID 已死亡（即使心跳时间很新）
  // 两者任一命中即清理。

  // 收集需要清理的成员：心跳超时 OR PID 已死
  const zombieMembers = new Set<string>();
  const staleMembers = scanStaleHeartbeats(MEMBERS_DIR, HEARTBEAT_TIMEOUT_MS);
  for (const m of staleMembers) zombieMembers.add(m);

  // 额外检查：心跳存在但 PID 已死（覆盖 kill -9 后不到 3 分钟的窗口期）
  // heartbeat 不存 lstart，所以只做 PID 存活检查（kill -0）
  if (fs.existsSync(MEMBERS_DIR)) {
    const entries = fs.readdirSync(MEMBERS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || zombieMembers.has(entry.name)) continue;
      const hb = readHeartbeat(MEMBERS_DIR, entry.name);
      if (!hb) continue;
      try {
        process.kill(hb.session_pid, 0);
        // PID 存活，不清理
      } catch {
        // PID 不存在，无论心跳多新都要清理
        zombieMembers.add(entry.name);
      }
    }
  }

  for (const member of zombieMembers) {
    process.stderr.write(`[heartbeat-sweep] ${member} zombie detected, auto cleanup\n`);

    // 找到持锁的 session 并释放
    for (const session of sessions.values()) {
      const lock = readLock(MEMBERS_DIR, member);
      if (lock && lock.session_pid === session.pid) {
        const nonce = session.lockNonces.get(member) ?? lock.nonce;
        const result = releaseLock(MEMBERS_DIR, member, nonce);
        if (result.success) {
          session.lockNonces.delete(member);
          appendWorkLog(MEMBERS_DIR, member, {
            event: "check_out",
            timestamp: new Date().toISOString(),
            project: lock.project,
            task: lock.task,
            note: "auto-released by heartbeat sweep (zombie)",
          });
        }
        break;
      }
    }

    // 如果 lock 不属于任何 session（Panel 直接持有的），也要强制清理
    const remainingLock = readLock(MEMBERS_DIR, member);
    if (remainingLock && !isProcessAlive(remainingLock.session_pid, remainingLock.session_start)) {
      forceRelease(MEMBERS_DIR, member);
      appendWorkLog(MEMBERS_DIR, member, {
        event: "check_out",
        timestamp: new Date().toISOString(),
        project: remainingLock.project,
        task: remainingLock.task,
        note: "force-released by heartbeat sweep (orphan lock, pid dead)",
      });
    }

    await cleanupMemberMcps(member);
    removeHeartbeat(MEMBERS_DIR, member);

    // 清理所有 session 中对该成员的追踪
    for (const session of sessions.values()) {
      session.activatedMembers.delete(member);
      session.memorySavedMembers.delete(member);
      session.lockNonces.delete(member);
    }
  }

  // 预约超时扫描（纯磁盘）
  const memberDirs = fs.existsSync(MEMBERS_DIR)
    ? fs.readdirSync(MEMBERS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];
  for (const memberName of memberDirs) {
    const res = readReservationFile(memberName);
    if (!res) continue;
    const elapsed = Date.now() - res.created_at;
    const leaderSession = sessions.get(res.session_id);
    const leaderAlive = leaderSession && isProcessAlive(leaderSession.pid, leaderSession.lstart);
    if (!leaderAlive) {
      deleteReservationFile(memberName);
      process.stderr.write(`[reservation-sweep] ${memberName} reservation released (leader session gone)\n`);
    } else if (elapsed > res.ttl_ms) {
      deleteReservationFile(memberName);
      process.stderr.write(`[reservation-sweep] ${memberName} reservation expired (${Math.round(elapsed/1000)}s)\n`);
    }
  }
}, HEARTBEAT_SWEEP_INTERVAL_MS);

// ──────────────────────────────────────────────
// Session 巡检（60s，检测死掉的 session PID）
// ──────────────────────────────────────────────
setInterval(async () => {
  for (const [id, session] of sessions) {
    if (!isProcessAlive(session.pid, session.lstart)) {
      process.stderr.write(`[session-sweep] session ${id} (pid=${session.pid}) dead, cleaning up\n`);
      await unregisterSession(id);
    }
  }
}, HEARTBEAT_SWEEP_INTERVAL_MS);

// ──────────────────────────────────────────────
// 优雅退出
// ──────────────────────────────────────────────
const HUB_PID_FILE = path.join(HUB_DIR, "hub.pid");
const HUB_PORT_FILE = path.join(HUB_DIR, "hub.port");

async function shutdown(): Promise<void> {
  process.stderr.write("[hub] shutting down...\n");
  try {
    fs.rmSync(HUB_PID_FILE, { force: true });
    fs.rmSync(HUB_PORT_FILE, { force: true });
  } catch { /* ignore */ }
  // 清理所有子 MCP 进程
  try { await cleanupAllMcps(); } catch { /* ignore */ }
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ──────────────────────────────────────────────
// 初始化 MCP 代理层
// ──────────────────────────────────────────────
initProxy(HUB_DIR);

// ──────────────────────────────────────────────
// 启动 HTTP 服务
// ──────────────────────────────────────────────
server.listen(HUB_PORT, HUB_HOST, () => {
  // 写 hub.pid 和 hub.port 文件（方便 thin client 发现）
  fs.writeFileSync(HUB_PID_FILE, String(process.pid), "utf-8");
  fs.writeFileSync(HUB_PORT_FILE, String(HUB_PORT), "utf-8");

  process.stderr.write(
    `[hub] started on ${HUB_HOST}:${HUB_PORT}, pid=${process.pid}, hub_dir=${HUB_DIR}\n`
  );
});
